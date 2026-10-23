// Generates each language SDK's wire types from the JSON Schemas in schema/: the attempt protocol
// (schema/protocol/) and the declaration tree (schema/plan/declaration.schema.json). The types
// are the SDK's private view of the wire; its public API stays hand-written.
//
//   node scripts/sdk-types.ts           writes them
//   node scripts/sdk-types.ts --check   fails when they're stale
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Schema = {
  $ref?: string
  type?: string | string[]
  const?: unknown
  enum?: unknown[]
  anyOf?: Schema[]
  oneOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean | Schema
  description?: string
}

const pkg = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = [
  ...readdirSync(join(pkg, 'schema/protocol'))
    .filter((f) => f.endsWith('.schema.json'))
    .sort()
    .map((f) => join('schema/protocol', f)),
  'schema/plan/declaration.schema.json',
]
export const PYTHON_OUT = join(pkg, '../reeval-python/src/reeval_python/_wire.py')

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A schema as its meaning: unions in one order, and no keywords that don't change the type. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value).sort(([a], [b]) => byCodePoint(a, b))) {
    if (key === 'propertyNames' || key === 'description') continue
    if ((key === 'properties' || key === 'required') && Object.keys(v as object).length === 0)
      continue
    out[key] =
      key === 'anyOf' || key === 'oneOf'
        ? (v as unknown[])
            .map(canonical)
            .sort((a, b) => byCodePoint(JSON.stringify(a), JSON.stringify(b)))
        : canonical(v)
  }
  return out
}

/** Every `$def` of the sources, by name; one name with two shapes is an error. */
export function definitions(
  files: Record<string, Schema>[] = SOURCES.map(
    (source) => JSON.parse(readFileSync(join(pkg, source), 'utf8')).$defs,
  ),
): Map<string, Schema> {
  const defs = new Map<string, Schema>()
  const seen = new Map<string, string>()
  for (const file of files) {
    for (const [name, schema] of Object.entries(file)) {
      const shape = JSON.stringify(canonical(schema))
      const before = seen.get(name)
      if (before !== undefined && before !== shape) {
        throw new Error(`$defs/${name} differs between the schemas; give one of them another name`)
      }
      seen.set(name, shape)
      defs.set(name, schema)
    }
  }
  return new Map([...defs].sort(([a], [b]) => byCodePoint(a, b)))
}

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')

const DISCRIMINATORS = ['op', 'type', 't', 'kind']

const isIdentifier = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !PY_KEYWORDS.has(key)

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(
    ' ',
  ),
)

// What the generated file itself refers to, which a def can't be named.
const TYPING = ['Any', 'Literal', 'NotRequired', 'TypeAlias', 'TypedDict']

// The keywords mapped to a type, and the value constraints a static type can't carry. Anything
// else (`allOf`, `not`, `prefixItems`, …) would change what's valid, so it fails the generator
// rather than weakening the type.
const MAPPED = new Set([
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'items',
  'properties',
  'required',
  'additionalProperties',
  '$ref',
])
const IGNORED = new Set([
  'description',
  'title',
  'default',
  'examples',
  'readOnly',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'propertyNames',
])

const pyLiteral = (value: unknown, where: string) => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (value === null) return 'None'
  if (Number.isInteger(value)) return String(value)
  throw new Error(`${where}: no Python Literal for ${JSON.stringify(value)}`)
}

function mappable(schema: Schema, where: string) {
  for (const key of Object.keys(schema)) {
    if (!MAPPED.has(key) && !IGNORED.has(key)) {
      throw new Error(`${where}: the generator can't map the keyword ${key}`)
    }
  }
}

/** Whether an object schema names its keys (a TypedDict) rather than being a record. */
const hasFields = (schema: Schema) => Object.keys(schema.properties ?? {}).length > 0

const wrapped = (text: string, indent: string, width = 96) => {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && indent.length + 2 + line.length + 1 + word.length > width) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    lines.push(line)
  }
  return lines.map((l) => `${indent}# ${l}`.trimEnd())
}

/** Every camelCase property name, and every property that is a record somewhere. */
function keyTables(defs: Map<string, Schema>) {
  const camel = new Set<string>()
  const records = new Set<string>()
  const durations = new Set<string>()
  const seen = new Set<Schema>()
  const resolve = (schema: Schema): Schema =>
    schema.$ref ? (defs.get(schema.$ref.replace('#/$defs/', '')) ?? {}) : schema
  const isRecord = (schema: Schema): boolean => {
    const s = resolve(schema)
    const union = s.anyOf ?? s.oneOf
    if (union) return union.some(isRecord)
    const types = Array.isArray(s.type) ? s.type : [s.type]
    return types.includes('object') && !hasFields(s)
  }
  const isDuration = (schema: Schema): boolean =>
    schema.$ref === '#/$defs/Duration' || (schema.anyOf ?? schema.oneOf ?? []).some(isDuration)
  const walk = (schema: Schema) => {
    if (seen.has(schema)) return
    seen.add(schema)
    const s = resolve(schema)
    if (s !== schema) return walk(s)
    for (const variant of s.anyOf ?? s.oneOf ?? []) walk(variant)
    if (s.items) walk(s.items)
    if (typeof s.additionalProperties === 'object') walk(s.additionalProperties)
    for (const [key, prop] of Object.entries(s.properties ?? {})) {
      if (/[A-Z]/.test(key)) camel.add(key)
      if (isRecord(prop)) records.add(key)
      if (isDuration(prop)) durations.add(key)
      walk(prop)
    }
  }
  for (const schema of defs.values()) walk(schema)
  return { camel, records, durations }
}

/** Python: each named object a TypedDict, each other named schema an alias. */
export function python(defs: Map<string, Schema> = definitions()): string {
  for (const name of defs.keys()) {
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name) || PY_KEYWORDS.has(name) || TYPING.includes(name)) {
      throw new Error(`$defs/${name} can't be a Python name: rename it`)
    }
  }
  const blocks: string[] = []
  const synthetic = new Set<string>()

  // A nested schema's name comes from where it is; one that would rebind a def or a name the
  // file uses is an error, since the SDK imports these names.
  const fresh = (name: string) => {
    let candidate = name
    for (let n = 2; synthetic.has(candidate); n++) candidate = `${name}${n}`
    if (defs.has(candidate) || TYPING.includes(candidate)) {
      throw new Error(`the generated name ${candidate} is also a $def: rename the $def`)
    }
    synthetic.add(candidate)
    return candidate
  }

  function typeOf(schema: Schema, hint: string): string {
    mappable(schema, hint)
    if (schema.$ref) {
      const name = /^#\/\$defs\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(schema.$ref)?.[1]
      if (!name || !defs.has(name)) throw new Error(`${hint}: can't resolve $ref ${schema.$ref}`)
      return name
    }
    if ('const' in schema) return `Literal[${pyLiteral(schema.const, hint)}]`
    if (schema.enum) return `Literal[${schema.enum.map((v) => pyLiteral(v, hint)).join(', ')}]`
    const union = schema.anyOf ?? schema.oneOf
    if (union) {
      const parts = union.map((variant, i) => typeOf(variant, variantName(variant, hint, i)))
      return [...new Set(parts)].join(' | ')
    }
    if (Array.isArray(schema.type)) {
      return schema.type.map((t) => typeOf({ ...schema, type: t }, hint)).join(' | ')
    }
    switch (schema.type) {
      case 'string':
        return 'str'
      case 'integer':
        return 'int'
      case 'number':
        return 'float'
      case 'boolean':
        return 'bool'
      case 'null':
        return 'None'
      case 'array':
        return `list[${schema.items ? typeOf(schema.items, `${hint}Item`) : 'Any'}]`
      case 'object': {
        if (hasFields(schema)) return typedDict(fresh(hint), schema)
        const values = schema.additionalProperties
        return `dict[str, ${typeof values === 'object' ? typeOf(values, `${hint}Value`) : 'Any'}]`
      }
      case undefined:
        return 'Any'
      default:
        throw new Error(`${hint}: the generator can't map the type ${schema.type}`)
    }
  }

  function variantName(variant: Schema, parent: string, index: number): string {
    if (variant.anyOf || variant.oneOf) return parent
    for (const key of DISCRIMINATORS) {
      const value = variant.properties?.[key]?.const
      if (typeof value === 'string') return `${parent}${pascal(value)}`
    }
    if (variant.properties?.ok?.const === false) return `${parent}Error`
    const required = variant.required ?? []
    const keys = required.length === 1 ? required : Object.keys(variant.properties ?? {})
    const [only] = keys
    if (keys.length === 1 && only) return `${parent}${pascal(only)}`
    return `${parent}${index + 1}`
  }

  function typedDict(name: string, schema: Schema): string {
    mappable(schema, name)
    const others = schema.additionalProperties
    if (typeof others === 'object' && Object.keys(others).length > 0) {
      throw new Error(`${name}: a TypedDict can't have both fields and other keys`)
    }
    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties ?? {}).map(([key, prop]) => {
      const type = typeOf(prop, `${name}${pascal(key)}`)
      return { key, prop, type: required.has(key) ? type : `NotRequired[${type}]` }
    })
    const doc = schema.description ? wrapped(schema.description, '') : []
    if (fields.every((f) => isIdentifier(f.key))) {
      const body = fields.flatMap((f) => [
        ...(f.prop.description ? wrapped(f.prop.description, '    ') : []),
        `    ${f.key}: ${f.type}`,
      ])
      blocks.push(
        [...doc, `class ${name}(TypedDict):`, ...(body.length ? body : ['    pass'])].join('\n'),
      )
    } else {
      const body = fields.map((f) => `        ${JSON.stringify(f.key)}: ${JSON.stringify(f.type)},`)
      blocks.push(
        [
          ...doc,
          `${name} = TypedDict(`,
          `    ${JSON.stringify(name)},`,
          '    {',
          ...body,
          '    },',
          ')',
        ].join('\n'),
      )
    }
    return name
  }

  for (const [name, schema] of defs) {
    if (schema.type === 'object' && hasFields(schema)) {
      typedDict(name, schema)
      continue
    }
    const type = typeOf(schema, name)
    const doc = schema.description ? wrapped(schema.description, '') : []
    blocks.push([...doc, `${name}: TypeAlias = ${JSON.stringify(type)}`].join('\n'))
  }

  const { camel, records, durations } = keyTables(defs)
  const frozenset = (names: Set<string>) =>
    `frozenset(\n    {\n${[...names]
      .sort(byCodePoint)
      .map((n) => `        ${JSON.stringify(n)},\n`)
      .join('')}    }\n)`
  blocks.push(
    [
      "# reeval's camelCase keys: the SDK takes each in snake_case too.",
      `CAMEL_KEYS: frozenset[str] = ${frozenset(camel)}`,
    ].join('\n'),
    [
      "# Fields whose keys are the eval's own (env, headers, …), which keep their spelling.",
      `RECORD_FIELDS: frozenset[str] = ${frozenset(records)}`,
    ].join('\n'),
    [
      '# Fields that take a duration: the SDK takes seconds or a timedelta.',
      `DURATION_FIELDS: frozenset[str] = ${frozenset(durations)}`,
    ].join('\n'),
  )

  return `${[
    `"""reeval's wire types, generated from its JSON Schemas in packages/reeval:`,
    '',
    ...SOURCES.map((s) => `- ${s}`),
    '',
    "Generated by packages/reeval/scripts/sdk-types.ts; don't edit. Private: the SDK's public API",
    "is hand-written and doesn't expose these. Static types only: the aliases are strings at",
    "runtime, so `typing.get_type_hints` and runtime validators can't read them.",
    '"""',
    '',
    'from __future__ import annotations',
    '',
    'from typing import Any, Literal, NotRequired, TypeAlias, TypedDict',
    '',
    '',
  ].join('\n')}${blocks.join('\n\n\n')}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = python()
  if (process.argv.includes('--check')) {
    let current = ''
    try {
      current = readFileSync(PYTHON_OUT, 'utf8')
    } catch {}
    if (current !== out) {
      console.error(`${PYTHON_OUT} is stale: run pnpm --filter reeval sdk-types`)
      process.exit(1)
    }
  } else writeFileSync(PYTHON_OUT, out)
}
