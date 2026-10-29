// Cursor's model catalog, read once a run on the host before any sandbox starts: what each
// planned Cursor cell's `effort` and `params` must name, and the effort a cell that sets none
// runs at.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CursorSdkModelEntry,
  cursorEffortParam,
  cursorModelEntry,
  cursorModelParams,
  fetchCursorModelCatalog,
} from '@reeval/harness-cursor-sdk'
import { UsageError } from '../errors.ts'
import { harnessId } from '../options.ts'
import { cacheDir } from '../root.ts'
import type { CursorEfforts, CursorHarnessDescriptor, HarnessDescriptor } from '../types.ts'

/** How long a catalog read for a key is reused, across runs. */
const CATALOG_TTL_MS = 60 * 60 * 1000

const cacheFile = (key: string) =>
  join(
    cacheDir(),
    `cursor-models-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`,
  )

/** The cached catalog for `key` while it's fresh, else null. */
async function readCached(key: string, now: number): Promise<CursorSdkModelEntry[] | null> {
  try {
    const cached = JSON.parse(await readFile(cacheFile(key), 'utf8')) as {
      fetchedAt?: unknown
      items?: unknown
    }
    const at = typeof cached.fetchedAt === 'string' ? Date.parse(cached.fetchedAt) : Number.NaN
    if (Number.isNaN(at) || now - at > CATALOG_TTL_MS || !Array.isArray(cached.items)) return null
    return cached.items as CursorSdkModelEntry[]
  } catch {
    return null
  }
}

/** Best-effort: a cache that can't be written only means reading the catalog again next run. */
async function writeCached(key: string, items: CursorSdkModelEntry[], now: number) {
  const file = cacheFile(key)
  const tmp = `${file}.${process.pid}`
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(tmp, JSON.stringify({ fetchedAt: new Date(now).toISOString(), items }))
    await rename(tmp, file)
  } catch {}
}

type CatalogOptions = { now?: number; fetch?: typeof fetch }

/**
 * The catalog `key` sees: the cached copy within the hour (unless `fresh`), else
 * `GET /v1/models`. `cached` says which.
 */
export async function cursorCatalog(
  key: string,
  { now = Date.now(), fresh = false, fetch }: CatalogOptions & { fresh?: boolean } = {},
): Promise<{ items: CursorSdkModelEntry[]; cached: boolean }> {
  const cached = fresh ? null : await readCached(key, now)
  if (cached) return { items: cached, cached: true }
  const items = await fetchCursorModelCatalog(
    { apiKey: key },
    { signal: AbortSignal.timeout(15_000), ...(fetch ? { fetch } : {}) },
  ).catch((error: Error) => {
    throw new Error(error.message.replace(/^Cursor's model catalog request failed: /, ''))
  })
  await writeCached(key, items, now)
  return { items, cached: false }
}

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

/**
 * Why `h`'s `effort` or `params` don't fit what `catalog` lists for its model, as a sentence
 * that says what to change, or undefined when they do.
 */
export function cursorCatalogProblem(
  h: CursorHarnessDescriptor,
  catalog: readonly CursorSdkModelEntry[],
): string | undefined {
  const entry = cursorModelEntry(catalog, h.model)
  if (!entry) {
    const some = catalog.slice(0, 5).map((m) => m.id)
    return `Cursor's model catalog for this CURSOR_API_KEY has no model ${h.model}; name one it lists, e.g. ${quoted(some)}`
  }
  const params = cursorModelParams(entry)
  const takes = params.length
    ? `it takes ${params.map((p) => `${p.id} (${quoted(p.values)})`).join(', ')}`
    : 'it takes none'
  for (const [id, value] of Object.entries(h.params ?? {})) {
    const param = params.find((p) => p.id === id)
    if (!param) {
      return `cursor({ params }) sets ${id}, which Cursor's model catalog doesn't list for ${h.model} (${takes})`
    }
    if (param.values.length && !param.values.includes(value)) {
      return `cursor({ params }) sets ${id}: '${value}', but ${h.model} takes ${id} ${quoted(param.values)}`
    }
  }
  if (h.effort === undefined) return undefined
  const effort = cursorEffortParam(catalog, h.model)
  if (!effort) {
    const fast = params.some((p) => p.id === 'fast') ? '; Fast is params.fast, not effort' : ''
    return `Cursor's model catalog lists no effort for ${h.model} (${takes}), so drop cursor({ effort: '${h.effort}' })${fast}`
  }
  if (effort.values.length && !effort.values.includes(h.effort)) {
    return `cursor({ effort }) on ${h.model} is one of ${quoted(effort.values)} (got '${h.effort}')`
  }
  const set = h.params?.[effort.id]
  if (set !== undefined && set !== h.effort) {
    return `cursor({ effort: '${h.effort}' }) and params.${effort.id} ('${set}') disagree; set one of them`
  }
  return undefined
}

/** What `catalog` says of each model's effort, for {@link CursorEfforts}. */
export function cursorEfforts(
  models: Iterable<string>,
  catalog: readonly CursorSdkModelEntry[],
): CursorEfforts {
  const out: CursorEfforts = {}
  for (const model of models) {
    const param = cursorEffortParam(catalog, model)
    out[model] = param ? { param: param.id, levels: param.values } : null
  }
  return out
}

/** A planned attempt's eval and harness, for {@link checkCursorCatalog}. */
type Planned = { attempt: { name: string; groups: string[]; harness: HarnessDescriptor } }

/**
 * Checks every planned Cursor harness against `catalog` and returns what it says of their
 * models' effort; throws a UsageError naming the first eval and cell that doesn't fit.
 */
export function checkCursorCatalog(
  planned: readonly Planned[],
  catalog: readonly CursorSdkModelEntry[],
): CursorEfforts {
  const models = new Set<string>()
  const seen = new Set<string>()
  for (const { attempt } of planned) {
    const h = attempt.harness
    if (h.kind !== 'cursor') continue
    models.add(h.model)
    const id = harnessId(h)
    if (seen.has(id)) continue
    seen.add(id)
    const problem = cursorCatalogProblem(h, catalog)
    if (problem) {
      const where = `evaluate("${[...attempt.groups, attempt.name].join(' › ')}")`
      throw new UsageError(`${where} on ${id}: ${problem}`)
    }
  }
  return cursorEfforts(models, catalog)
}

/**
 * {@link checkCursorCatalog} against the catalog `key` sees. A cached copy can predate a model
 * or level Cursor added since, so a cell it refuses is checked again against a fresh read. A
 * catalog that can't be read is returned as the Error.
 */
export async function checkCursorPlan(
  key: string,
  planned: readonly Planned[],
  options: CatalogOptions = {},
): Promise<CursorEfforts | Error> {
  const catalog = await cursorCatalog(key, options).catch((error: Error) => error)
  if (catalog instanceof Error) return catalog
  try {
    return checkCursorCatalog(planned, catalog.items)
  } catch (error) {
    if (!catalog.cached) throw error
    const fresh = await cursorCatalog(key, { ...options, fresh: true }).catch(() => {
      throw error
    })
    return checkCursorCatalog(planned, fresh.items)
  }
}
