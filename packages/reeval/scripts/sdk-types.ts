// Generates each language SDK's wire types from the JSON Schemas in schema/: the attempt protocol
// (schema/protocol/) and the declaration tree (schema/plan/declaration.schema.json). The types
// are the SDK's private view of the wire; its public API stays hand-written.
//
//   node scripts/sdk-types.ts           writes them
//   node scripts/sdk-types.ts --check   fails when they're stale
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Schema = {
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

/** A schema as its meaning: unions in one order, and no keywords that don't change the type. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'propertyNames' || key === 'description') continue
    if ((key === 'properties' || key === 'required') && Object.keys(v as object).length === 0)
      continue
    out[key] =
      key === 'anyOf' || key === 'oneOf'
        ? (v as unknown[])
            .map(canonical)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : canonical(v)
  }
  return out
}

/** Every `$def` of the sources, by name; one name with two shapes is an error. */
function definitions(): Map<string, Schema> {
  const defs = new Map<string, Schema>()
  const seen = new Map<string, string>()
  for (const source of SOURCES) {
    const file = JSON.parse(readFileSync(join(pkg, source), 'utf8')) as {
      $defs: Record<string, Schema>
    }
    for (const [name, schema] of Object.entries(file.$defs)) {
      const shape = JSON.stringify(canonical(schema))
      const before = seen.get(name)
      if (before !== undefined && before !== shape) {
        throw new Error(`$defs/${name} differs between the schemas; give one of them another name`)
      }
      seen.set(name, shape)
      defs.set(name, schema)
    }
  }
  return new Map([...defs].sort(([a], [b]) => a.localeCompare(b)))
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

const pyLiteral = (value: unknown) =>
  typeof value === 'string'
    ? JSON.stringify(value)
    : value === true
      ? 'True'
      : value === false
        ? 'False'
        : value === null
          ? 'None'
          : String(value)

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

/** Python: each named object a TypedDict, each other named schema an alias. */
export function python(): string {
  const defs = definitions()
  const blocks: string[] = []
  const taken = new Set(defs.keys())

  const fresh = (name: string) => {
    let candidate = name
    for (let n = 2; taken.has(candidate); n++) candidate = `${name}${n}`
    taken.add(candidate)
    return candidate
  }

  function typeOf(schema: Schema, hint: string): string {
    if (schema.$ref) return schema.$ref.replace('#/$defs/', '')
    if ('const' in schema) return `Literal[${pyLiteral(schema.const)}]`
    if (schema.enum) return `Literal[${schema.enum.map(pyLiteral).join(', ')}]`
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
        if (schema.properties) return typedDict(fresh(hint), schema)
        const values = schema.additionalProperties
        return `dict[str, ${typeof values === 'object' ? typeOf(values, `${hint}Value`) : 'Any'}]`
      }
      default:
        return 'Any'
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
    if (schema.type === 'object' && schema.properties) {
      typedDict(name, schema)
      continue
    }
    const type = typeOf(schema, name)
    const doc = schema.description ? wrapped(schema.description, '') : []
    blocks.push([...doc, `${name}: TypeAlias = ${JSON.stringify(type)}`].join('\n'))
  }

  return `${[
    `"""reeval's wire types, generated from its JSON Schemas in packages/reeval:`,
    '',
    ...SOURCES.map((s) => `- ${s}`),
    '',
    "Generated by packages/reeval/scripts/sdk-types.ts; don't edit. Private: the SDK's public API",
    "is hand-written and doesn't expose these.",
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
      console.error(`${PYTHON_OUT} is stale: run pnpm --filter reeval sdk:types`)
      process.exit(1)
    }
  } else writeFileSync(PYTHON_OUT, out)
}
