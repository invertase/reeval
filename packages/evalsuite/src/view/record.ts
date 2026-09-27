// How a file ES wrote earlier (or later) reads in this ES. Browser-safe. Every reader of a run
// record, transcript line and analysis document goes through here, and `pnpm schema:check` holds
// the types to it: a field added as required needs a read default below, or a schemaVersion bump
// with a migration.

import type { RunRecord } from '../history/types.ts'
import { SCHEMA_VERSION } from '../history/types.ts'
import type { AnalysisDoc } from './analysis.ts'
import type { DebugRequest } from './debug.ts'
import type { TranscriptLine } from './model.ts'

/** Each shape ES persists and reads back; `schema/<name>.schema.json` is its snapshot. */
export type ShapeName = 'run-record' | 'transcript-line' | 'analysis' | 'debug-request'

/**
 * A field added after files were written without it, and what it reads as there. The path is
 * dotted, `[]` walks an array's items, `{}` a record's values and `<type=tool>` picks one variant
 * of a union, e.g. `evals[].attempts[].egress` or `<type=tool>.ok`.
 */
export type ReadDefault = { path: string; empty: () => unknown }

export const READ_DEFAULTS: Record<ShapeName, ReadDefault[]> = {
  'run-record': [
    { path: 'plan.sandboxWarnings', empty: () => [] },
    { path: 'stack.harnesses[].resolvedModels', empty: () => [] },
    { path: 'evals[].todo', empty: () => false },
  ],
  'transcript-line': [],
  analysis: [],
  'debug-request': [],
}

/**
 * Turns a file at schemaVersion `n` into one at `n + 1`, keyed by `n`. A change that can't be a new
 * optional field or a read default bumps the shape's schemaVersion and adds one here.
 */
export const MIGRATIONS: Partial<Record<ShapeName, Record<number, (value: never) => unknown>>> = {}

/** The newest schemaVersion of each versioned shape this ES reads. */
export const SCHEMA_VERSIONS = { 'run-record': SCHEMA_VERSION, analysis: 1 } as const

/** A file from a newer ES, whose schemaVersion this ES doesn't know. */
export class NewerSchemaError extends Error {
  override name = 'NewerSchemaError'
  /** The message without its subject: `written by a newer ES (…). Upgrade ES to read it.` */
  readonly reason: string
  constructor(what: string, version: number, newest: number) {
    const reason = `written by a newer ES (schemaVersion ${version}; this ES reads up to ${newest}). Upgrade ES to read it.`
    super(`${what} was ${reason}`)
    this.reason = reason
  }
}

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function fill(value: unknown, segments: string[], empty: () => unknown): void {
  if (!isObject(value)) return
  const [head = '', ...rest] = segments
  const branch = /^<(\w+)=(.+)>$/.exec(head)
  if (branch) {
    if (String(value[branch[1] as string]) === branch[2]) fill(value, rest, empty)
    return
  }
  const [, key = head, walk] = /^(.+?)(\[\]|\{\})?$/.exec(head) ?? []
  if (!rest.length && !walk) {
    if (value[key] === undefined) value[key] = empty()
    return
  }
  const child = value[key]
  const children =
    walk === '[]'
      ? Array.isArray(child)
        ? child
        : []
      : walk === '{}'
        ? isObject(child)
          ? Object.values(child)
          : []
        : [child]
  for (const c of children) fill(c, rest, empty)
}

/** Fills in each read default of `shape` that `value` is missing, in place. */
export function fillDefaults<T>(shape: ShapeName, value: T): T {
  for (const d of READ_DEFAULTS[shape]) fill(value, d.path.split('.'), d.empty)
  return value
}

function upgrade<T>(shape: keyof typeof SCHEMA_VERSIONS, value: T, what: string): T {
  const newest = SCHEMA_VERSIONS[shape]
  let version = (value as Obj).schemaVersion
  if (typeof version !== 'number') return value
  if (version > newest) throw new NewerSchemaError(what, version, newest)
  let v: unknown = value
  for (; version < newest; version++) {
    const migrate = MIGRATIONS[shape]?.[version]
    if (!migrate) break
    v = migrate(v as never)
  }
  return v as T
}

/**
 * A record as every reader sees it: migrated to this ES's schemaVersion, with each field added
 * after it was written read as its default, so older runs keep loading in `es show`, `es query`,
 * compare, history and the studio. A record from a newer ES throws a `NewerSchemaError`.
 */
export function readableRecord(record: RunRecord, what = `Run ${record.runId}`): RunRecord {
  return fillDefaults('run-record', upgrade('run-record', record, what))
}

/** A transcript line as every reader sees it. */
export const readableTranscriptLine = (line: TranscriptLine): TranscriptLine =>
  fillDefaults('transcript-line', line)

/** An analysis document as every reader sees it; one from a newer ES throws. */
export const readableAnalysis = (doc: AnalysisDoc, what = 'This analysis'): AnalysisDoc =>
  fillDefaults('analysis', upgrade('analysis', doc, what))

/** A gateway request line from `.es/debug` as the studio sees it. */
export const readableDebugRequest = (request: DebugRequest): DebugRequest =>
  fillDefaults('debug-request', request)
