// The `$defs` whose source of truth is a Zod schema in src/contract/, not the TypeScript type: their
// JSON Schema comes from `z.toJSONSchema`, with Zod's descriptions, patterns and bounds. The
// hand-written type a def replaces is held to its schema twice: at compile time (each contract
// module's `_SameAsSchema`), and here, where the def generated from the type and Zod's must have
// the same properties, the same required ones and the same descriptions.
import { z } from 'zod'
import { CONTRACT_SCHEMAS } from '../../src/contract/index.ts'
import type { Schema } from './generate.ts'

let cached: Record<string, Schema> | undefined

/** Zod's JSON Schema for every contract schema, by its `$def` name. */
export function zodDefs(
  schemas: Record<string, z.ZodType> = CONTRACT_SCHEMAS,
): Record<string, Schema> {
  if (cached && schemas === CONTRACT_SCHEMAS) return cached
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(schemas)) registry.add(schema, { id })
  const out = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    uri: (id) => `#/$defs/${id}`,
  }).schemas
  const defs = Object.fromEntries(
    Object.entries(out).map(([id, { $schema: _, $id: __, ...schema }]) => [
      id,
      canonical(schema) as Schema,
    ]),
  )
  if (schemas === CONTRACT_SCHEMAS) cached = defs
  return defs
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
 * named by their constant fields) by its properties, which are required and their descriptions.
 */
export function differences(generated: Schema, zod: Schema): string[] {
  const a = facts(generated)
  const b = facts(zod)
  return [
    ...[...a].filter((f) => !b.has(f)).map((f) => `type only:  ${f}`),
    ...[...b].filter((f) => !a.has(f)).map((f) => `Zod only:   ${f}`),
  ]
}

function facts(schema: Schema): Set<string> {
  const out = new Set<string>()
  if (schema.description) out.add(`(description) ${schema.description}`)
  const objects = (schema.anyOf ?? schema.oneOf ?? [schema]).filter(
    (s) => s.type === 'object' && s.properties,
  )
  for (const object of objects) {
    const properties = object.properties ?? {}
    const variant = Object.entries(properties)
      .filter(([, p]) => p.const !== undefined)
      .map(([k, p]) => `${k}=${String(p.const)}`)
      .sort()
      .join(',')
    const prefix = variant && objects.length > 1 ? `{${variant}}.` : ''
    for (const [key, p] of Object.entries(properties)) {
      const required = object.required?.includes(key) ? '' : '?'
      out.add(`${prefix}${key}${required}${p.description ? `: ${p.description}` : ''}`)
    }
  }
  return out
}
