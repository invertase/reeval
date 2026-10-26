// The `$defs` whose source of truth is a Zod schema in src/contract/, not the TypeScript type: their
// JSON Schema comes from `z.toJSONSchema`, with Zod's patterns and bounds, and the descriptions of
// the hand-written type's TSDoc, the one copy of the contract's docs. That type is held to its
// schema twice: at compile time (each contract module's `_SameAsSchema`), and here, where the def
// generated from the type and Zod's must have the same properties and the same required ones.
import { z } from 'zod'
import { CONTRACT_REFS, CONTRACT_SCHEMAS } from '../../src/contract/index.ts'
import type { Schema } from './generate.ts'

/**
 * A Zod schema and the def generated from the type whose TSDoc describes it, wherever the schema
 * appears (a `$def`, or inlined). With `shared`, the type only documents the fields the schema
 * shares with it: the schema's own description, and any field it describes in its own words, stay.
 */
export type TypeDocs = { name: string; schema: z.ZodType; typed: Schema; shared?: boolean }

/** Zod's JSON Schema for every contract schema, by its `$def` name, described by `docs`. */
export function zodDefs(
  schemas: Record<string, z.ZodType> = CONTRACT_SCHEMAS,
  refs: Record<string, z.ZodType> = CONTRACT_REFS,
  docs: TypeDocs[] = [],
): Record<string, Schema> {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries({ ...refs, ...schemas })) registry.add(schema, { id })
  const index = new Map(docs.map((d, i) => [d.schema, i]))
  const out = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    uri: (id) => `#/$defs/${id}`,
    override: ({ zodSchema, jsonSchema }) => {
      const i = index.get(zodSchema as z.ZodType)
      if (i !== undefined) (jsonSchema as Record<string, unknown>)[DOCS] = i
    },
  }).schemas
  const shared = (out.__shared?.$defs ?? {}) as Record<string, unknown>
  const raw = JSON.stringify(inlineShared(out, shared))
  const problems: string[] = []
  withDocs(JSON.parse(raw), docs, (d) => (node, description, at) => {
    if (d.shared && !at) return
    if (node.description === description || (node.description && !d.shared)) {
      problems.push(
        `${d.name}${at}: its Zod schema's .describe() ${node.description === description ? 'repeats' : 'contradicts'} the TSDoc "${description}"`,
      )
    }
  })
  if (problems.length) {
    throw new Error(
      `The TSDoc of the hand-written types describes these, so delete the .describe() in src/contract/:\n  ${problems.join('\n  ')}`,
    )
  }
  const fromTypes = new Set(docs.flatMap((d) => descriptionsIn(d.typed)))
  const described = withDocs(JSON.parse(raw), docs, (d) => (node, description, at) => {
    const zodsOwn = node.description !== undefined && !fromTypes.has(node.description)
    if (!(d.shared && (!at || zodsOwn))) node.description = description
  }) as typeof out
  return Object.fromEntries(
    Object.entries(described)
      .filter(([id]) => !(id in refs) && id !== '__shared')
      .map(([id, { $schema: _, $id: __, ...schema }]) => [id, canonical(schema) as Schema]),
  )
}

const descriptionsIn = (schema: Schema): string[] =>
  JSON.stringify(schema)
    .match(/"description":"(?:[^"\\]|\\.)*"/g)
    ?.map((pair) => JSON.parse(pair.slice('"description":'.length)) as string) ?? []

/** Marks, in Zod's output, a node whose schema `docs` describes, by its index there. */
const DOCS = 'x-reeval-docs'

type SetDoc = (node: Schema, description: string, at: string) => void

/**
 * `value` with each node Zod marked described by its `docs` entry, through `set`: children first,
 * so a property's description goes over the one its schema has wherever it appears.
 */
function withDocs(value: unknown, docs: TypeDocs[], set: (d: TypeDocs) => SetDoc): unknown {
  if (Array.isArray(value)) return value.map((v) => withDocs(v, docs, set))
  if (typeof value !== 'object' || value === null) return value
  const node = Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, withDocs(v, docs, set)]),
  ) as Schema & { [DOCS]?: number }
  const i = node[DOCS]
  if (i === undefined) return node
  delete node[DOCS]
  const d = docs[i] as TypeDocs
  fillDocs(node, d.typed, set(d))
  return node
}

/**
 * `value` with each `$ref` to a schema Zod pulled out on its own (the inside of a recursive
 * `z.lazy`, which has no name) replaced by that schema, merged with what sits beside the `$ref`.
 */
function inlineShared(value: unknown, shared: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => inlineShared(v, shared))
  if (typeof value !== 'object' || value === null) return value
  const { $ref, ...rest } = value as Record<string, unknown>
  const name =
    typeof $ref === 'string' ? /^#\/\$defs\/__shared#\/\$defs\/(.+)$/.exec($ref)?.[1] : undefined
  const base = name === undefined ? ($ref === undefined ? {} : { $ref }) : (shared[name] as object)
  const merged: Record<string, unknown> = { ...base, ...rest }
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, inlineShared(v, shared)]))
}

/** Laid out like the defs generated from types: description first, properties and `required` sorted. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  const { description, ...rest } = value as Record<string, unknown>
  const out: Record<string, unknown> = description === undefined ? {} : { description }
  for (const [key, inner] of Object.entries(rest)) {
    if (key === 'properties') {
      const sorted = Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      )
      out[key] = Object.fromEntries(sorted.map(([k, v]) => [k, canonical(v)]))
    } else if (key === 'required') out[key] = [...(inner as string[])].sort()
    else out[key] = canonical(inner)
  }
  return out
}

/**
 * `defs` with each def a Zod schema owns replaced by Zod's JSON Schema, after checking the two
 * agree, plus the Zod-only defs those refer to (`Duration`).
 */
export function withZodDefs(
  defs: Record<string, Schema>,
  owned: Record<string, Schema> = zodDefs(),
): Record<string, Schema> {
  const out: Record<string, Schema> = {}
  for (const [name, schema] of Object.entries(defs)) {
    const zod = owned[name]
    if (zod) {
      const drift = differences(schema, zod)
      if (drift.length) {
        throw new Error(
          `${name}'s TypeScript type and its Zod schema in src/contract/ disagree:\n  ${drift.join('\n  ')}`,
        )
      }
    }
    out[name] = zod ?? schema
  }
  for (let added = true; added; ) {
    added = false
    for (const [, ref] of JSON.stringify(out).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) {
      const name = ref as string
      if (out[name]) continue
      const zod = owned[name]
      if (!zod) throw new Error(`a Zod-owned def refers to ${name}, which isn't in $defs`)
      out[name] = zod
      added = true
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Where a def generated from a type and Zod's differ, as lines: each object (a union's variants
 * named by their constant fields) by its properties and which are required.
 */
export function differences(generated: Schema, zod: Schema): string[] {
  const a = facts(generated)
  const b = facts(zod)
  return [
    ...[...a].filter((f) => !b.has(f)).map((f) => `type only:  ${f}`),
    ...[...b].filter((f) => !a.has(f)).map((f) => `Zod only:   ${f}`),
  ]
}

const objectsOf = (schema: Schema) =>
  (schema.anyOf ?? schema.oneOf ?? [schema]).filter((s) => s.type === 'object' && s.properties)

/** The constant fields that tell a union's object variants apart: `kind=docker`. */
const variantOf = (object: Schema) =>
  Object.entries(object.properties ?? {})
    .filter(([, p]) => p.const !== undefined)
    .map(([k, p]) => `${k}=${String(p.const)}`)
    .sort()
    .join(',')

function facts(schema: Schema): Set<string> {
  const out = new Set<string>()
  const objects = objectsOf(schema)
  for (const object of objects) {
    const variant = variantOf(object)
    const prefix = variant && objects.length > 1 ? `{${variant}}.` : ''
    for (const key of Object.keys(object.properties ?? {})) {
      out.add(`${prefix}${key}${object.required?.includes(key) ? '' : '?'}`)
    }
  }
  return out
}

const isObject = (s: Schema) => s.type === 'object' && s.properties !== undefined
const keysOf = (object: Schema) =>
  Object.keys(object.properties ?? {})
    .sort()
    .join(',')
/** A union's object variant pairs with the one that has its constant fields, else its keys. */
const sameVariant = (a: Schema, b: Schema) =>
  variantOf(a) ? variantOf(a) === variantOf(b) : keysOf(a) === keysOf(b)
/** What a union's other members are, to pair each with its twin: `array`, `string`, a `$ref`. */
const shapeOf = (s: Schema) => s.$ref ?? JSON.stringify(s.type ?? s.const ?? s.enum ?? null)

/**
 * Walks Zod's JSON Schema `node` beside the def generated from its type, calling `set` wherever
 * the type has a description: the node itself, each property, and on into inline objects, list
 * items, record values and union members, up to a `$ref` (which its own schema describes). Each
 * child it walks into is a copy, so a node Zod shares between schemas keeps its own description.
 */
function fillDocs(
  node: Schema,
  typed: Schema,
  set: (node: Schema, description: string, at: string) => void,
  at = '',
): void {
  if (typed.description) set(node, typed.description, at)
  if (node.$ref || typed.$ref) return
  const into = (child: Schema, twin: Schema, where: string) => {
    const copy = { ...child }
    fillDocs(copy, twin, set, where)
    return copy
  }
  if (node.items && typed.items) node.items = into(node.items, typed.items, `${at}[]`)
  if (
    typeof node.additionalProperties === 'object' &&
    typeof typed.additionalProperties === 'object'
  )
    node.additionalProperties = into(
      node.additionalProperties,
      typed.additionalProperties,
      `${at}{}`,
    )
  const union = node.anyOf ? 'anyOf' : node.oneOf ? 'oneOf' : undefined
  const typedObjects = objectsOf(typed)
  if (union) {
    const members = node[union] as Schema[]
    const objects = members.filter(isObject)
    const others = (typed.anyOf ?? typed.oneOf ?? []).filter((t) => !isObject(t))
    node[union] = members.map((member) => {
      const twin = isObject(member)
        ? objects.length === 1 && typedObjects.length === 1
          ? typedObjects[0]
          : typedObjects.find((t) => sameVariant(t, member))
        : others.find((t) => shapeOf(t) === shapeOf(member))
      return twin ? into(member, twin, at) : member
    })
  } else if (node.properties && typedObjects.length === 1) {
    const properties = typedObjects[0]?.properties ?? {}
    node.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, property]) => {
        const twin = properties[key]
        return [key, twin ? into(property, twin, `${at}.${key}`) : property]
      }),
    )
  }
}

/**
 * Contract schemas no plan type has a `$def` for, so only their module's `_SameAsSchema` holds
 * them to their type, with why.
 */
export const ZOD_ONLY: Record<string, string> = {
  Duration: 'a union alias, which the type generator inlines',
  GatePolicy: 'a union alias, which the type generator inlines',
}

/**
 * Fails unless every contract schema is checked against the def generated from its type (`typed`
 * names every def the plan shapes' types produced), or is in `ZOD_ONLY`.
 */
export function checkContractCoverage(
  typed: ReadonlySet<string>,
  schemas: Record<string, z.ZodType> = CONTRACT_SCHEMAS,
  zodOnly: Record<string, string> = ZOD_ONLY,
): void {
  const problems = [
    ...Object.keys(schemas)
      .filter((name) => !typed.has(name) && !(name in zodOnly))
      .map(
        (name) =>
          `${name} is in CONTRACT_SCHEMAS but no plan type has a def by that name, so nothing checks it against its type: name it after its type, or add it to ZOD_ONLY with why`,
      ),
    ...Object.keys(zodOnly)
      .filter((name) => typed.has(name) || !(name in schemas))
      .map((name) =>
        typed.has(name)
          ? `${name} is in ZOD_ONLY but a plan type has a def for it now: drop it from ZOD_ONLY`
          : `${name} is in ZOD_ONLY but not in CONTRACT_SCHEMAS: drop it from ZOD_ONLY`,
      ),
  ]
  if (problems.length) throw new Error(problems.join('\n'))
}
