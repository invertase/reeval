// List prices for the dry run's cost estimate, fetched when it's shown and never stored in a
// record: prices change, so reeval keeps no table of its own. models.dev's direct providers, and
// Vercel AI Gateway's `provider/model` ids, cached on the host for a day, and an older copy when
// it can't be reached; a failed fetch isn't retried for an hour. `REEVAL_PRICES` names a file of
// your own prices that win over models.dev's, or `none` for tokens only.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { get as httpGet, type IncomingMessage } from 'node:http'
import { get as httpsGet } from 'node:https'
import { join, resolve } from 'node:path'
import { createBrotliDecompress, createGunzip } from 'node:zlib'
import { fromCwd } from './ids.ts'
import { cacheDir } from './root.ts'

export const MODELS_DEV = 'https://models.dev/api.json'
/** The providers whose own API a harness or judge calls; the first one wins on a shared id. */
const PROVIDERS = ['anthropic', 'openai', 'google', 'xai']
/** Its ids name the provider (`anthropic/claude-sonnet-4.5`), so they never shadow a direct one. */
const GATEWAY = 'vercel'
const FRESH_MS = 24 * 60 * 60_000
const RETRY_MS = 60 * 60_000
const FETCH_TIMEOUT_MS = 2000

/** USD per million tokens: input, cache read, cache write, output. */
export type Price = readonly [number, number, number, number]

/** models.dev's cost fields, which a `REEVAL_PRICES` file uses too. */
type Cost = { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown }

/** When models.dev's prices were fetched, and whether that's an older copy for want of a newer. */
export type ModelsDev = { fetchedAt: string; stale: boolean } | { why: string }

export type Prices =
  | {
      /** models.dev's; empty when it couldn't be reached and a file supplied prices. */
      table: Record<string, Price>
      /** The `REEVAL_PRICES` file's, which win over models.dev's; null without one. */
      overlay: Record<string, Price> | null
      /** That file, from the working directory; null without one. */
      file: string | null
      modelsDev: ModelsDev
    }
  | { table: null; why: string }

const usd = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const isPrice = (p: unknown): p is Price => Array.isArray(p) && p.length === 4 && p.every(usd)

/** Null without an input and output price, or with any field that isn't a USD amount. */
function priceOf(c: Cost | undefined): Price | null {
  if (!c || !usd(c.input) || !usd(c.output)) return null
  const cacheRead = c.cache_read ?? c.input
  const cacheWrite = c.cache_write ?? c.input
  return usd(cacheRead) && usd(cacheWrite) ? [c.input, cacheRead, cacheWrite, c.output] : null
}

type Catalog = Record<string, { models?: Record<string, { cost?: Cost }> }>

function tableOf(catalog: Catalog): Record<string, Price> {
  const table: Record<string, Price> = {}
  for (const provider of [...PROVIDERS, GATEWAY]) {
    for (const [id, model] of Object.entries(catalog[provider]?.models ?? {})) {
      const price = priceOf(model.cost)
      const key = id.toLowerCase()
      if (price && !table[key]) table[key] = price
    }
  }
  return table
}

type Cached = { fetchedAt: string; table: Record<string, Price> }
const cacheFile = () => join(cacheDir(), 'models-dev-prices.json')
const failedFile = () => join(cacheDir(), 'models-dev-failed.json')

/** The cached copy, or null when it's missing, unreadable or not one reeval wrote. */
async function readCached(): Promise<Cached | null> {
  try {
    const cached = JSON.parse(await readFile(cacheFile(), 'utf8')) as Partial<Cached>
    if (typeof cached.fetchedAt !== 'string' || Number.isNaN(Date.parse(cached.fetchedAt))) {
      return null
    }
    if (!cached.table || typeof cached.table !== 'object') return null
    if (!Object.values(cached.table).every(isPrice)) return null
    return { fetchedAt: cached.fetchedAt, table: cached.table }
  } catch {
    return null
  }
}

/** When a fetch last failed; null when none is on record. */
async function readFailedAt(): Promise<number | null> {
  try {
    const at = Date.parse((JSON.parse(await readFile(failedFile(), 'utf8')) as { at: string }).at)
    return Number.isNaN(at) ? null : at
  } catch {
    return null
  }
}

/** Best-effort: a cache that can't be written only means fetching again next time. */
async function writeCacheFile(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}`
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(tmp, JSON.stringify(value))
    await rename(tmp, file)
  } catch {}
}

/**
 * The JSON at `url`, or a rejection after `ms`. The deadline destroys the socket too: `fetch`'s
 * abort leaves a pending connect open until its own 10s timeout, holding the process past it.
 */
function getJson(url: string, ms: number): Promise<unknown> {
  return new Promise((done, fail) => {
    const get = url.startsWith('https:') ? httpsGet : httpGet
    const request = get(url, { agent: false, headers: { 'accept-encoding': 'br, gzip' } }, (res) =>
      read(res).then(done, fail),
    )
    const timer = setTimeout(() => request.destroy(new Error(`no answer in ${ms}ms`)), ms)
    request.on('error', fail)
    request.on('close', () => clearTimeout(timer))
  })
}

async function read(res: IncomingMessage): Promise<unknown> {
  if (res.statusCode !== 200) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode}`)
  }
  const encoding = res.headers['content-encoding']
  const body =
    encoding === 'br'
      ? res.pipe(createBrotliDecompress())
      : encoding === 'gzip'
        ? res.pipe(createGunzip())
        : res
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** models.dev's prices, an older copy, or why there are none. */
async function modelsDev(
  now: number,
  url: string,
  timeoutMs: number,
): Promise<{ table: Record<string, Price>; modelsDev: ModelsDev } | { why: string }> {
  const cached = await readCached()
  const age = cached ? now - Date.parse(cached.fetchedAt) : Number.NaN
  if (cached && age >= 0 && age < FRESH_MS) {
    return { table: cached.table, modelsDev: { fetchedAt: cached.fetchedAt, stale: false } }
  }
  const failedAt = await readFailedAt()
  let retryIn = failedAt === null ? 0 : failedAt + RETRY_MS - now
  if (retryIn <= 0 || retryIn > RETRY_MS) {
    try {
      const fetchedAt = new Date(now).toISOString()
      const table = tableOf((await getJson(url, timeoutMs)) as Catalog)
      await writeCacheFile(cacheFile(), { fetchedAt, table })
      await rm(failedFile(), { force: true }).catch(() => {})
      return { table, modelsDev: { fetchedAt, stale: false } }
    } catch {
      await writeCacheFile(failedFile(), { at: new Date(now).toISOString() })
      retryIn = RETRY_MS
    }
  }
  if (cached) {
    return { table: cached.table, modelsDev: { fetchedAt: cached.fetchedAt, stale: true } }
  }
  return { why: `models.dev unreachable, next try in ${Math.ceil(retryIn / 60_000)}m` }
}

async function ownPrices(path: string): Promise<Record<string, Price>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, Cost>
  const table: Record<string, Price> = {}
  for (const [id, cost] of Object.entries(parsed)) {
    const price = priceOf(cost)
    if (!price) throw new Error(`${id} needs input and output, in USD per million tokens`)
    table[id.toLowerCase()] = price
  }
  return table
}

/** The prices the estimate uses now, or why there are none. */
export async function loadPrices(
  env = process.env,
  now = Date.now(),
  source = { url: MODELS_DEV, timeoutMs: FETCH_TIMEOUT_MS },
): Promise<Prices> {
  const setting = env.REEVAL_PRICES?.trim()
  if (setting === 'none') return { table: null, why: 'REEVAL_PRICES=none' }
  let overlay: Record<string, Price> | null = null
  const file = setting ? fromCwd(resolve(setting)) : null
  if (setting) {
    try {
      overlay = await ownPrices(setting)
    } catch (error) {
      return { table: null, why: `REEVAL_PRICES ${file}: ${(error as Error).message}` }
    }
  }
  const fetched = await modelsDev(now, source.url, source.timeoutMs)
  if ('table' in fetched) return { ...fetched, overlay, file }
  if (!overlay) return { table: null, why: fetched.why }
  return { table: {}, overlay, file, modelsDev: fetched }
}
