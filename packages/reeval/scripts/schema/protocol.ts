// The attempt protocol's JSON Schemas in schema/protocol/, generated from the Zod schemas in
// src/contract/attempt.ts. A def that shares a hand-written type (`TurnData`, `ExecResult`, …) is
// held to the def generated from that type: the same properties, required ones and descriptions.
import { ATTEMPT_SCHEMAS, ATTEMPT_TYPES } from '../../src/contract/attempt.ts'
import { generate, type Schema, type ShapeSchema } from './generate.ts'
import { PROTOCOL_SHAPES } from './shapes.ts'
import { differences, zodDefs } from './zod.ts'

/** The `$defs` `root` refers to, itself included, sorted by name. */
function reachable(defs: Record<string, Schema>, root: string): Record<string, Schema> {
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    const def = defs[name]
    if (!def)
      throw new Error(`the attempt protocol refers to ${name}, which isn't in ATTEMPT_SCHEMAS`)
    seen.add(name)
    for (const [, ref] of JSON.stringify(def).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) {
      visit(ref as string)
    }
  }
  visit(root)
  return Object.fromEntries(
    [...seen].sort((a, b) => a.localeCompare(b)).map((name) => [name, defs[name] as Schema]),
  )
}

/**
 * Where a protocol def and the def generated from its hand-written type in src/types.ts differ,
 * as lines naming the def.
 */
export function typeDrift(defs: Record<string, Schema>): string[] {
  const generated = generate(
    ATTEMPT_TYPES.map((type) => ({ name: type, file: 'src/types.ts', type, where: type })),
  )
  return ATTEMPT_TYPES.flatMap((type) => {
    const fromType = generated.get(type)?.$defs[type] ?? {}
    return differences(fromType, defs[type] ?? {}).map((line) => `${type}: ${line}`)
  })
}

/** Every protocol shape's JSON Schema, by its name. */
export function protocolDocs(): Map<string, ShapeSchema> {
  const defs = zodDefs(ATTEMPT_SCHEMAS, {})
  const drift = typeDrift(defs)
  if (drift.length) {
    throw new Error(
      `the attempt protocol's Zod schemas in src/contract/attempt.ts and their types in src/types.ts disagree:\n  ${drift.join('\n  ')}`,
    )
  }
  return new Map(
    PROTOCOL_SHAPES.map((shape) => [
      shape.name,
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $comment: `Generated from ${shape.root} in src/contract/attempt.ts by \`pnpm schema:update\`; don't edit. ${shape.where}.`,
        title: shape.root,
        $ref: `#/$defs/${shape.root}`,
        $defs: reachable(defs, shape.root),
      },
    ]),
  )
}
