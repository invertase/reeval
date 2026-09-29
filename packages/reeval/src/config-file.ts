// `reeval.yml`: the config as data, for projects not written in TypeScript. It's checked against
// schema/plan/config.schema.json (generated from `ConfigData`), so a Dart or Python project gets
// the same keys and descriptors as `reeval.config.ts`, and reading it never runs the project's
// language. Two tags stand in for the TypeScript helpers: `!secret` and `!file`.
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseDocument, type Tags } from 'yaml'
import { DART_INCLUDE, detectLanguage } from './dart/project.ts'
import { environmentFrom } from './environment.ts'
import { UsageError } from './errors.ts'
import { ownFile } from './root.ts'
import type { ConfigData, EnvironmentFile, EsConfig } from './types.ts'

export const DATA_CONFIG_FILES = ['reeval.yml', 'reeval.yaml']

export const isDataConfig = (path: string | undefined): path is string =>
  !!path && /\.ya?ml$/.test(path)

type Schema = {
  $ref?: string
  type?: string
  const?: unknown
  enum?: unknown[]
  anyOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: Schema
}
type SchemaDoc = { $ref: string; $defs: Record<string, Schema> }

let schema: SchemaDoc | undefined
const configSchema = (): SchemaDoc =>
  (schema ??= JSON.parse(readFileSync(ownFile('schema/plan/config.schema.json'), 'utf8')))

const deref = (doc: SchemaDoc, s: Schema): Schema => {
  let out = s
  while (out.$ref) out = doc.$defs[out.$ref.replace('#/$defs/', '')] ?? {}
  return out
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** Where `value` doesn't fit, as `path: problem`; unknown keys are problems too. */
function check(doc: SchemaDoc, s: Schema, value: unknown, path: string, out: string[]): void {
  const at = path || '(root)'
  const r = deref(doc, s)
  if (r.anyOf) {
    const tries = r.anyOf.map((a) => {
      const problems: string[] = []
      check(doc, a, value, path, problems)
      return problems
    })
    if (tries.some((p) => p.length === 0)) return
    // The variant it was meant to be: the one whose `kind` (or other const) matches, else the closest.
    const meant = r.anyOf.findIndex((a) =>
      Object.entries(deref(doc, a).properties ?? {}).some(
        ([k, p]) =>
          deref(doc, p).const !== undefined &&
          (value as Record<string, unknown> | null)?.[k] === deref(doc, p).const,
      ),
    )
    if (meant >= 0) return void out.push(...(tries[meant] ?? []))
    const kinds = r.anyOf
      .map((a) => deref(doc, a).properties?.kind?.const)
      .filter((k) => k !== undefined)
    out.push(
      kinds.length && typeof value === 'object'
        ? `${at}: kind must be one of ${kinds.join(', ')}`
        : `${at}: ${[...tries].sort((a, b) => a.length - b.length)[0]?.[0] ?? 'no variant fits'}`,
    )
    return
  }
  if (r.const !== undefined && value !== r.const)
    return void out.push(`${at}: must be ${JSON.stringify(r.const)}`)
  if (r.enum && !r.enum.includes(value as never))
    return void out.push(`${at}: must be one of ${r.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  const t = typeOf(value)
  if (r.type && r.type !== t && !(r.type === 'number' && t === 'number'))
    return void out.push(
      `${at}: must be ${r.type === 'object' ? 'a mapping' : `a ${r.type}`} (got ${t})`,
    )
  if (r.type === 'array' && r.items) {
    for (const [i, item] of (value as unknown[]).entries()) {
      check(doc, r.items, item, `${path}[${i}]`, out)
    }
  }
  if (r.type === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of r.required ?? [])
      if (!(key in obj)) out.push(`${path ? `${path}.` : ''}${key}: is required`)
    for (const [key, v] of Object.entries(obj)) {
      const sub = r.properties?.[key] ?? r.additionalProperties
      if (!sub) {
        const known = Object.keys(r.properties ?? {})
        out.push(
          `${path ? `${path}.` : ''}${key}: unknown key${known.length ? ` (known: ${known.join(', ')})` : ''}`,
        )
      } else check(doc, sub, v, path ? `${path}.${key}` : key, out)
    }
  }
}

/** `!secret` (the variable is the key it's under), `!secret NAME`, or `!secret { from, hosts, … }`. */
const tags = (root: string): Tags => [
  {
    tag: '!secret',
    resolve: (from: string) => ({ kind: 'secret', ...(from ? { from } : {}) }),
  },
  {
    tag: '!secret',
    collection: 'map',
    resolve: (map) => ({ kind: 'secret', ...(map.toJSON() as object) }),
  } as Tags[number],
  { tag: '!file', resolve: (path: string) => ({ kind: 'file', path: resolve(root, path) }) },
]

/** Paths a TypeScript helper would resolve against the calling file, resolved against the config. */
function resolvePaths(value: unknown, root: string, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => resolvePaths(v, root))
  if (!value || typeof value !== 'object') {
    return key === 'dockerfile' && typeof value === 'string' && !isAbsolute(value)
      ? resolve(root, value)
      : value
  }
  const obj = value as Record<string, unknown>
  const out = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolvePaths(v, root, k)]))
  if (obj.kind === 'skill' && obj.source === 'local' && typeof obj.path === 'string')
    out.path = resolve(root, obj.path)
  return out
}

/** Reads `reeval.yml` as `EsConfig`: parsed, checked against the schema, paths and environments revived. */
export function loadDataConfig(path: string, root: string, label: string): EsConfig {
  const doc = parseDocument(readFileSync(path, 'utf8'), {
    customTags: tags(root),
    prettyErrors: true,
  })
  if (doc.errors.length) throw new UsageError(`${label}: ${doc.errors[0]?.message}`)
  const data = (doc.toJS() ?? {}) as unknown
  const problems: string[] = []
  const s = configSchema()
  check(s, { $ref: s.$ref }, data, '', problems)
  if (problems.length) {
    throw new UsageError(
      `${label} doesn't fit the config schema:\n${problems.map((p) => `  ${p}`).join('\n')}`,
    )
  }
  const config = resolvePaths(data, root) as ConfigData
  const revive = (env: EnvironmentFile | undefined) => {
    if (!env) return undefined
    const { name, ...spec } = env
    return environmentFrom({ kind: 'environment', name, layers: [{ name, spec }] })
  }
  const profiles = config.profiles
    ? Object.fromEntries(
        Object.entries(config.profiles).map(([name, p]) => [
          name,
          p.defaults?.environment
            ? { ...p, defaults: { ...p.defaults, environment: revive(p.defaults.environment) } }
            : p,
        ]),
      )
    : undefined
  return {
    ...config,
    ...(config.include ? {} : detectLanguage(root) === 'dart' ? { include: DART_INCLUDE } : {}),
    ...(config.environment ? { environment: revive(config.environment) } : {}),
    ...(profiles ? { profiles } : {}),
  } as EsConfig
}
