// The `$defs` whose source of truth is a Zod schema in src/contract/, not the TypeScript type: their
// JSON Schema comes from `z.toJSONSchema`, with Zod's descriptions, patterns and bounds. The type
// they replace is held to the schema at compile time (`_SameAsSchema`), so the shapes agree.
import { z } from 'zod'
import { CONTRACT_SCHEMAS } from '../../src/contract/docker.ts'
import type { Schema } from './generate.ts'

let cached: Record<string, Schema> | undefined

function zodDefs(): Record<string, Schema> {
  if (cached) return cached
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(CONTRACT_SCHEMAS)) registry.add(schema, { id })
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    uri: (id) => `#/$defs/${id}`,
  })
  cached = Object.fromEntries(
    Object.entries(schemas).map(([id, { $schema: _, $id: __, ...schema }]) => [
      id,
      schema as Schema,
    ]),
  )
  return cached
}

/** `defs` with each def a Zod schema owns replaced by Zod's JSON Schema for it. */
export function withZodDefs(defs: Record<string, Schema>): Record<string, Schema> {
  const owned = zodDefs()
  const out = Object.fromEntries(
    Object.entries(defs).map(([name, schema]) => [name, owned[name] ?? schema]),
  )
  for (const ref of JSON.stringify(out).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) {
    if (!out[ref[1] as string]) throw new Error(`a Zod-owned def refers to ${ref[1]}, not in $defs`)
  }
  return out
}
