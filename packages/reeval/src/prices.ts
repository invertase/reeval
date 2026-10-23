// List prices for the dry run's cost estimate, fetched when it's shown and never stored in a
// record: prices change, so reeval keeps no table of its own. models.dev's direct providers,
// cached on the host for a day, and an older copy when it can't be reached; `REEVAL_PRICES`
// names a file of your own prices instead, or `none` for tokens only.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fromCwd } from './ids.ts'
import { cacheDir } from './root.ts'

export const MODELS_DEV = 'https://models.dev/api.json'
/** The providers whose own API a harness or judge calls; the first one wins on a shared id. */
const PROVIDERS = ['anthropic', 'openai', 'google', 'xai']
const FRESH_MS = 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 5000

/** USD per million tokens: input, cache read, cache write, output. */
export type Price = readonly [number, number, number, number]

/** models.dev's cost fields, which a `REEVAL_PRICES` file uses too. */
type Cost = { input?: number; output?: number; cache_read?: number; cache_write?: number }

export type Prices =
  | {
      table: Record<string, Price>
      /** `models.dev`, or the `REEVAL_PRICES` file. */
      source: string
      /** When models.dev was fetched; null when only a file supplied them. */
      fetchedAt: string | null
      /** models.dev couldn't be reached, so this is an older copy. */
      stale: boolean
    }
  | { table: null; why: string }

const priceOf = (c: Cost | undefined): Price | null =>
  c?.input == null || c.output == null
    ? null
    : [c.input, c.cache_read ?? c.input, c.cache_write ?? c.input, c.output]

type Catalog = Record<string, { models?: Record<string, { cost?: Cost }> }>

function tableOf(catalog: Catalog): Record<string, Price> {
  const table: Record<string, Price> = {}
  for (const provider of PROVIDERS) {
    for (const [id, model] of Object.entries(catalog[provider]?.models ?? {})) {
      const price = priceOf(model.cost)
      if (price && !table[id]) table[id] = price
    }
  }
  return table
}

type Cached = { fetchedAt: string; table: Record<string, Price> }
const cacheFile = () => join(cacheDir(), 'models-dev-prices.json')

async function readCached(): Promise<Cached | null> {
  try {
    const cached = JSON.parse(await readFile(cacheFile(), 'utf8')) as Cached
    return cached.fetchedAt && cached.table ? cached : null
  } catch {
    return null
  }
}

/** Best-effort: a cache that can't be written only means fetching again next time. */
async function writeCached(cached: Cached): Promise<void> {
  const file = cacheFile()
  const tmp = `${file}.${process.pid}`
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(tmp, JSON.stringify(cached))
    await rename(tmp, file)
  } catch {}
}

async function modelsDev(now: number): Promise<Cached & { stale: boolean }> {
  const cached = await readCached()
  if (cached && now - Date.parse(cached.fetchedAt) < FRESH_MS) return { ...cached, stale: false }
  try {
    const response = await fetch(MODELS_DEV, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const fresh = {
      fetchedAt: new Date(now).toISOString(),
      table: tableOf((await response.json()) as Catalog),
    }
    await writeCached(fresh)
    return { ...fresh, stale: false }
  } catch (error) {
    if (cached) return { ...cached, stale: true }
    throw error
  }
}

async function ownPrices(path: string): Promise<Record<string, Price>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, Cost>
  const table: Record<string, Price> = {}
  for (const [id, cost] of Object.entries(parsed)) {
    const price = priceOf(cost)
    if (!price) throw new Error(`${id} needs at least input and output`)
    table[id] = price
  }
  return table
}

/** The prices the estimate uses now, or why there are none. */
export async function loadPrices(env = process.env, now = Date.now()): Promise<Prices> {
  const setting = env.REEVAL_PRICES?.trim()
  if (setting === 'none') return { table: null, why: 'REEVAL_PRICES=none' }
  if (setting) {
    const source = fromCwd(resolve(setting))
    try {
      return { table: await ownPrices(setting), source, fetchedAt: null, stale: false }
    } catch (error) {
      return { table: null, why: `REEVAL_PRICES ${source}: ${(error as Error).message}` }
    }
  }
  try {
    const fetched = await modelsDev(now)
    return { source: 'models.dev', ...fetched }
  } catch {
    return { table: null, why: 'models.dev unreachable' }
  }
}
