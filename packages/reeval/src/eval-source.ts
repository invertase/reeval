// What an eval's `sources` fingerprint part covers, the same in every language: the eval's own
// body (its function's source text), its declared options and its enclosing groups' (`tags`,
// `revision` and `gate` aside), an `evaluate.each` case's data, and its `revision`. Nothing else in
// the file is read: helpers, constants outside the body, fixtures and data it reads are the
// author's to mark by bumping `revision`. Packages are covered by the recorded lockfiles.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { originalText } from './engine/loader.ts'
import { isEnvironment } from './environment.ts'
import { UsageError } from './errors.ts'
import { relativeFile, sha256 } from './ids.ts'
import { isObjectLike } from './object.ts'
import { harnessId, sandboxId } from './options.ts'
import type {
  EvalOptions,
  EvalSource,
  HarnessDescriptor,
  Revision,
  SandboxDescriptor,
} from './types.ts'

/** Kept out of the options hash: `tags` (selection), `revision`'s own part, and the gate, which compare reads as a policy change. */
const UNHASHED = new Set(['tags', 'revision', 'gate'])

/**
 * The `sources` fingerprint part. An attempt without a source (one kept from a record that had
 * none, or one that never ran) hashes its eval file instead.
 */
export function sourcesPart(
  source: EvalSource | undefined,
  revision: Revision | undefined,
  files: ReadonlyArray<{ path: string; sha256: string }>,
): string {
  const what = source ?? { files }
  return sha256(canonicalJson({ ...what, ...(revision !== undefined ? { revision } : {}) }))
}

/**
 * sha256 of a TypeScript eval body's source text, as the file has it rather than as the loader
 * transformed it. Throws when it has none to read.
 */
export function bodyHash(fn: (...args: never[]) => unknown, where: string, file?: string): string {
  const text = Function.prototype.toString.call(fn)
  if (/\{\s*\[native code\]\s*\}\s*$/.test(text)) {
    throw new UsageError(
      `${where}'s body is a bound or built-in function, whose source reeval can't read to fingerprint the eval. Pass the function itself, e.g. async (c) => { … }, not fn.bind(…).`,
    )
  }
  return sha256(originalText(text, file) ?? text)
}

/**
 * sha256 of an `evaluate.each` case in canonical JSON. Throws on a value that isn't JSON data (a
 * class instance such as a RegExp or Map, a non-finite number), whose changes JSON can't see.
 */
export function caseHash(item: unknown, where: string, file?: string): string {
  const refuse = (what: string): never => {
    throw new UsageError(
      `${where}: reeval fingerprints each case as JSON data, and this one isn't (it holds ${what}). Pass plain objects, arrays, strings, finite numbers, booleans, null, functions or environments, and build the rest in the body.`,
    )
  }
  return sha256(canonicalJson(item, { file, refuse }))
}

/** sha256 of the eval's options and its enclosing groups', outermost first, in canonical form. */
export function optionsHash(levels: readonly EvalOptions[]): string {
  return sha256(
    canonicalJson(levels.map(canonicalOptions).filter((o) => Object.keys(o).length > 0)),
  )
}

/**
 * The eval file by path from `root` and content hash, for the record's `sources`: where the eval
 * lives, not a fingerprint input. None when it can't be read.
 */
export async function evalFile(
  root: string,
  file: string,
): Promise<Array<{ path: string; sha256: string }>> {
  const path = resolve(root, file)
  const bytes = await readFile(path).catch(() => null)
  return bytes ? [{ path: relativeFile(root, path), sha256: sha256(bytes) }] : []
}

/**
 * One level's options with each harness, sandbox, environment and judge model by its id rather
 * than its object: the cell's other fingerprint parts already cover what they hold, and their
 * objects carry host paths and functions.
 */
function canonicalOptions(options: EvalOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || UNHASHED.has(key)) continue
    if (key === 'harness') out[key] = harnessForm(value)
    else if (key === 'sandbox') out[key] = sandboxId(value as SandboxDescriptor)
    else if (key === 'judge' && isObjectLike(value)) {
      out[key] = { ...value, ...('model' in value ? { model: modelId(value.model) } : {}) }
    } else if (key === 'compare' && isObjectLike(value) && Array.isArray(value.harness)) {
      out[key] = { ...value, harness: value.harness.map(harnessForm) }
    } else out[key] = value
  }
  return out
}

function harnessForm(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'function') return value
  if (Array.isArray(value)) return value.map(harnessForm)
  if (isObjectLike(value) && 'add' in value) return { add: harnessForm(value.add) }
  if (isObjectLike(value) && 'only' in value) return value
  return harnessId(value as HarnessDescriptor)
}

function modelId(model: unknown): unknown {
  if (typeof model === 'string' || model === undefined) return model
  const m = model as { kind?: unknown; provider?: unknown; modelId?: unknown }
  if (m.kind === 'fake-judge') return model
  return typeof m.provider === 'string' && typeof m.modelId === 'string'
    ? `${m.provider}/${m.modelId}`
    : 'custom'
}

type Canonical = {
  /** The file the value was declared in, where a function's source is looked up first. */
  file?: string
  /** Called on a value whose JSON would lose what it holds; without it, that value is kept. */
  refuse?: (what: string) => never
}

/**
 * JSON with object keys sorted (by UTF-16 code unit) and `undefined` dropped. A function is its
 * source text as its file has it, an environment its name (its contents are the cell's
 * `environment` part), a bigint its digits, an object with `toJSON` what that returns.
 */
export function canonicalJson(value: unknown, how: Canonical = {}): string {
  return JSON.stringify(canonical(value, new Set(), how)) ?? 'null'
}

function canonical(value: unknown, path: Set<object>, how: Canonical): unknown {
  if (typeof value === 'function') {
    const text = Function.prototype.toString.call(value)
    return originalText(text, how.file) ?? text
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || value === undefined) return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) how.refuse?.(String(value))
  if (value === null || typeof value !== 'object') return value
  if (path.has(value)) return '[circular]'
  if (isEnvironment(value)) return { environment: value.name }
  const toJSON = (value as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') return canonical(toJSON.call(value), path, how)
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    how.refuse?.(`a ${proto?.constructor?.name ?? 'class instance'}`)
  }
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => canonical(v, path, how) ?? null)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = canonical((value as Record<string, unknown>)[key], path, how)
      if (v !== undefined) out[key] = v
    }
    return out
  } finally {
    path.delete(value)
  }
}
