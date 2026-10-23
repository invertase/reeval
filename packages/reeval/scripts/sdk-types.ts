// Generates each language SDK's wire types from the JSON Schemas in schema/: the attempt protocol
// (schema/protocol/) and the declaration tree (schema/plan/declaration.schema.json). The types
// are the SDK's private view of the wire; its public API stays hand-written.
//
//   node scripts/sdk-types.ts           writes them
//   node scripts/sdk-types.ts --check   fails when they're stale
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// URLs, not node:path, so the sources named in the generated file are POSIX paths on every host.
const pkg = new URL('..', import.meta.url)
const SOURCES = [
  ...readdirSync(new URL('schema/protocol/', pkg))
    .filter((f) => f.endsWith('.schema.json'))
    .sort(byCodePoint)
    .map((f) => `schema/protocol/${f}`),
  'schema/plan/declaration.schema.json',
]
export const PYTHON_OUT = fileURLToPath(new URL('../reeval-python/src/reeval_python/_wire.py', pkg))

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
    (source) => JSON.parse(readFileSync(new URL(source, pkg), 'utf8')).$defs,
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

/** A union variant's name: its discriminator's value, its only key, or its place. */
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

export const DART_OUT = fileURLToPath(new URL('../reeval-dart/lib/src/wire.g.dart', pkg))

const DART_RESERVED = new Set(
  'assert await break case catch class const continue default do else enum extends false final finally for if in is new null rethrow return super switch this throw true try var void while with yield'.split(
    ' ',
  ),
)

// The dart:core names the generated file itself uses, which a def can't be named.
const DART_USED = ['Map', 'List', 'Object', 'String', 'bool', 'int', 'num', 'Null']

// dart:core's other names: a def named one of them hides it in the generated file.
const DART_CORE = new Set(
  'BigInt Comparable DateTime Deprecated Duration Enum Error Exception Expando Finalizer Function Future Invocation Iterable Iterator Match Never Pattern Record RegExp Runes Set Sink StackTrace Stopwatch Stream StringBuffer StringSink Symbol Type Uri WeakReference double dynamic'.split(
    ' ',
  ),
)

/** Dart: each named object an extension type over its JSON map, each other named schema a typedef. */
export function dart(defs: Map<string, Schema> = definitions()): string {
  for (const name of defs.keys()) {
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name) || DART_USED.includes(name)) {
      throw new Error(`$defs/${name} can't be a Dart name: rename it`)
    }
  }
  const blocks: string[] = []
  const synthetic = new Set<string>()
  const aliases = new Map<string, string>()
  // A union def of object defs is an extension type each of them implements.
  const refName = (s: Schema) => /^#\/\$defs\/(\w+)$/.exec(s.$ref ?? '')?.[1]
  const isObjectDef = (name: string | undefined) => {
    const def = name === undefined ? undefined : defs.get(name)
    return def !== undefined && def.type === 'object' && hasFields(def)
  }
  const parents = new Map<string, string[]>()
  for (const [name, schema] of defs) {
    const union = schema.type ? undefined : (schema.anyOf ?? schema.oneOf)
    if (!union?.every((v) => isObjectDef(refName(v)))) continue
    for (const v of union) {
      const child = refName(v) as string
      parents.set(child, [...(parents.get(child) ?? []), name])
    }
  }
  const fresh = (name: string) => {
    let candidate = name
    for (let n = 2; synthetic.has(candidate); n++) candidate = `${name}${n}`
    if (defs.has(candidate) || DART_USED.includes(candidate) || DART_CORE.has(candidate)) {
      throw new Error(`the generated name ${candidate} is also a $def or a dart:core name`)
    }
    synthetic.add(candidate)
    return candidate
  }
  const docs = (text: string | undefined, indent: string) =>
    text ? wrapped(text, indent, 80).map((l) => l.replace(/^(\s*)#/, '$1///')) : []
  const field = (key: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`the key ${JSON.stringify(key)} can't be a Dart name`)
    }
    return DART_RESERVED.has(key) ? `${key}_` : key
  }
  const literal = (value: unknown, where: string) => {
    if (typeof value === 'string') return 'String'
    if (typeof value === 'boolean') return 'bool'
    if (value === null) return 'Null'
    if (Number.isInteger(value)) return 'int'
    throw new Error(`${where}: no Dart type for ${JSON.stringify(value)}`)
  }
  const nullable = (type: string) =>
    type.endsWith('?') || type === 'Null' || type === 'Object?' ? type : `${type}?`
  const allowsNull = (schema: Schema): boolean => {
    const ref = refName(schema)
    if (ref) return allowsNull(defs.get(ref) ?? {})
    if (
      schema.type === undefined &&
      !schema.anyOf &&
      !schema.oneOf &&
      !('const' in schema) &&
      !schema.enum
    )
      return !schema.$ref
    if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')))
      return true
    if ('const' in schema) return schema.const === null
    return (schema.anyOf ?? schema.oneOf ?? []).some(allowsNull)
  }
  const discriminator = (variants: Schema[]) =>
    DISCRIMINATORS.find((key) =>
      variants.every(
        (v) => typeof v.properties?.[key]?.const === 'string' && v.required?.includes(key),
      ),
    )

  function typeOf(schema: Schema, hint: string): string {
    mappable(schema, hint)
    if (schema.$ref) {
      const name = /^#\/\$defs\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(schema.$ref)?.[1]
      if (!name || !defs.has(name)) throw new Error(`${hint}: can't resolve $ref ${schema.$ref}`)
      return name
    }
    if ('const' in schema) return literal(schema.const, hint)
    if (schema.enum) {
      const types = new Set(schema.enum.map((v) => literal(v, hint)))
      return types.size === 1 ? [...types][0] : 'Object?'
    }
    const union = schema.anyOf ?? schema.oneOf
    if (union) return unionOf(union, hint)
    if (Array.isArray(schema.type)) {
      return unionOf(
        schema.type.map((t) => ({ ...schema, type: t })),
        hint,
      )
    }
    switch (schema.type) {
      case 'string':
        return 'String'
      case 'integer':
        return 'int'
      case 'number':
        return 'num'
      case 'boolean':
        return 'bool'
      case 'null':
        return 'Null'
      case 'array':
        return `List<${schema.items ? typeOf(schema.items, `${hint}Item`) : 'Object?'}>`
      case 'object': {
        if (hasFields(schema)) return extensionType(fresh(hint), schema)
        const values = schema.additionalProperties
        return `Map<String, ${typeof values === 'object' ? typeOf(values, `${hint}Value`) : 'Object?'}>`
      }
      case undefined:
        return 'Object?'
      default:
        throw new Error(`${hint}: the generator can't map the type ${schema.type}`)
    }
  }

  /** A union: an extension type its object variants implement, or the one Dart type it holds. */
  function unionOf(variants: Schema[], hint: string, own?: Schema): string {
    const isNull = (v: Schema) => v.type === 'null' || ('const' in v && v.const === null)
    const flat = (v: Schema): Schema[] => {
      const inner = v.anyOf ?? v.oneOf
      return inner && !v.type ? inner.flatMap(flat) : [v]
    }
    const rest = variants.flatMap(flat).filter((v) => !isNull(v))
    const optional = rest.length < variants.length
    const objects = rest.every((v) => v.type === 'object' && hasFields(v) && !v.$ref)
    let type: string
    if (objects && rest.length > 1) {
      type = own ? hint : fresh(hint)
      const key = discriminator(rest)
      const getter = key
        ? [`  String get ${field(key)} => json[${JSON.stringify(key)}] as String;`]
        : []
      blocks.push(
        [
          ...docs(own?.description, ''),
          `extension type const ${type}.fromJson(Map<String, Object?> json) implements Object {`,
          ...getter,
          '}',
        ].join('\n'),
      )
      rest.forEach((v, i) => {
        extensionType(fresh(variantName(v, hint, i)), v, type)
      })
    } else {
      const raw = rest.map((v, i) => typeOf(v, variantName(v, hint, i)))
      const parts = new Set(raw.map((t) => t.replace(/\?$/, '')))
      type = parts.size === 1 ? [...parts][0] : 'Object'
      if (parts.has('Object')) type = 'Object'
      if (rest.some(allowsNull)) return nullable(type)
    }
    return optional ? nullable(type) : type
  }

  function read(type: string, key: string, optional: boolean) {
    const at = `json[${JSON.stringify(key)}]`
    const q = optional ? '?' : ''
    const base = type.replace(/\?$/, '')
    const list = /^List<(.*)>$/.exec(base)
    if (list) return `(${at} as List<Object?>${q})${q}.cast<${list[1]}>()`
    const map = /^Map<String, (.*)>$/.exec(base)
    if (map) return `(${at} as Map<String, Object?>${q})${q}.cast<String, ${map[1]}>()`
    const target = optional ? nullable(type) : type
    const resolved = aliases.get(base) ?? base
    const top = resolved === 'Object?' || (resolved === 'Object' && target.endsWith('?'))
    if (target === 'Object?' || top) return at
    return `${at} as ${target}`
  }

  function extensionType(name: string, schema: Schema, implementsType = 'Object'): string {
    mappable(schema, name)
    const others = schema.additionalProperties
    if (typeof others === 'object' && Object.keys(others).length > 0) {
      throw new Error(`${name}: an extension type can't have both fields and other keys`)
    }
    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties ?? {}).map(([key, prop]) => {
      const type = typeOf(prop, `${name}${pascal(key)}`)
      const fixed = 'const' in prop && required.has(key) ? prop.const : undefined
      return { key, prop, type, name: field(key), optional: !required.has(key), fixed }
    })
    const params = fields
      .filter((f) => f.fixed === undefined)
      .map((f) => (f.optional ? `${nullable(f.type)} ${f.name}` : `required ${f.type} ${f.name}`))
    const entries = fields.map((f) => {
      const value =
        f.fixed !== undefined ? JSON.stringify(f.fixed) : f.optional ? `?${f.name}` : f.name
      return `${JSON.stringify(f.key)}: ${value}`
    })
    const getters = fields.flatMap((f) => [
      ...docs(f.prop.description, '  '),
      `  ${f.optional ? nullable(f.type) : f.type} get ${f.name} => ${read(f.type, f.key, f.optional)};`,
    ])
    blocks.push(
      [
        ...docs(schema.description, ''),
        `extension type const ${name}.fromJson(Map<String, Object?> json) implements ${implementsType} {`,
        `  ${name}(${params.length ? `{${params.join(', ')}}` : ''}) : json = {${entries.join(', ')}};`,
        ...getters,
        '}',
      ].join('\n'),
    )
    return name
  }

  // Twice: a field's type can be a def's alias that comes later in the file.
  for (const _ of [1, 2]) {
    blocks.length = 0
    synthetic.clear()
    for (const [name, schema] of defs) {
      if (schema.type === 'object' && hasFields(schema)) {
        extensionType(name, schema, parents.get(name)?.join(', '))
        continue
      }
      const union = schema.anyOf ?? schema.oneOf
      if (union?.every((v) => isObjectDef(refName(v))) && !schema.type) {
        const variants = union.map((v) => defs.get(refName(v) as string) as Schema)
        const key = discriminator(variants)
        blocks.push(
          [
            ...docs(schema.description, ''),
            `extension type const ${name}.fromJson(Map<String, Object?> json) implements Object {`,
            ...(key
              ? [`  String get ${field(key)} => json[${JSON.stringify(key)}] as String;`]
              : []),
            '}',
          ].join('\n'),
        )
        continue
      }
      if (union && !schema.type) {
        mappable(schema, name)
        const type = unionOf(union, name, schema)
        if (type === name) continue
        aliases.set(name, type)
        blocks.push([...docs(schema.description, ''), `typedef ${name} = ${type};`].join('\n'))
        continue
      }
      const type = typeOf(schema, name)
      aliases.set(name, type)
      blocks.push([...docs(schema.description, ''), `typedef ${name} = ${type};`].join('\n'))
    }
  }

  const hidden = [...defs.keys()].filter((n) => DART_CORE.has(n))
  return `${[
    `// reeval's wire types, generated from its JSON Schemas in packages/reeval:`,
    ...SOURCES.map((s) => `// - ${s}`),
    '//',
    "// Generated by packages/reeval/scripts/sdk-types.ts; don't edit. Each object is an extension",
    '// type over its JSON map, so a decoded message is used as it is, with no copy. The public API',
    '// is hand-written; package:reeval/wire.dart exports these for options it has no parameter for.',
    '// dart format off',
    '// ignore_for_file: unintended_html_in_doc_comment',
    'library;',
    '',
    ...(hidden.length ? [`import 'dart:core' hide ${hidden.join(', ')};`, ''] : []),
    '',
  ].join('\n')}${blocks.join('\n\n')}\n`
}

const OUTPUTS = [
  [PYTHON_OUT, python],
  [DART_OUT, dart],
] as const

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, generate] of OUTPUTS) {
    const out = generate()
    if (process.argv.includes('--check')) {
      let current = ''
      try {
        current = readFileSync(path, 'utf8')
      } catch {}
      if (current !== out) {
        console.error(`${path} is stale: run pnpm --filter reeval sdk-types`)
        process.exit(1)
      }
    } else writeFileSync(path, out)
  }
}
