// The plan handoff's contract: an eval file's groups, evals and todos as data, which `declareTree`
// declares for a runner in another language. Each node's options stay an object here: the
// options cascade checks them in its own words when the node is declared.
import { z } from 'zod'
import type {
  DeclarationTree,
  DeclaredEval,
  DeclaredFamily,
  DeclaredGroup,
  DeclaredMode,
  DeclaredNode,
  DeclaredSource,
  DeclaredTodo,
} from '../declaration.ts'
import type { EvalOptionsData } from '../types.ts'
import { type Assert, dataProblem, type Same } from './shared.ts'

/** A node's options: any object, until the cascade checks it. Its JSON Schema is the type's. */
export const evalOptionsDataSchema = z.record(z.string(), z.unknown()) as z.ZodType<EvalOptionsData>

export const declaredModeSchema = z.enum(['run', 'skip', 'only'])

export const declaredFamilySchema = z.strictObject({
  name: z.string(),
  case: z.number().int().min(0),
  cases: z.number().int().min(2),
})

export const declaredTodoSchema = z.strictObject({
  type: z.literal('todo'),
  name: z.string(),
})

const hash = () =>
  z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hash: 64 lowercase hex digits')

export const declaredSourceSchema = z.strictObject({
  body: hash(),
  case: hash().optional(),
})

export const declaredEvalSchema = z.strictObject({
  type: z.literal('eval'),
  name: z.string(),
  mode: declaredModeSchema,
  options: evalOptionsDataSchema,
  body: z.string(),
  source: declaredSourceSchema,
  family: declaredFamilySchema.optional(),
})

export const declaredGroupSchema = z.strictObject({
  type: z.literal('group'),
  name: z.string(),
  mode: declaredModeSchema,
  options: evalOptionsDataSchema,
  get children(): z.ZodArray<typeof declaredNodeSchema> {
    return z.array(declaredNodeSchema)
  },
})

export const declaredNodeSchema: z.ZodDiscriminatedUnion<
  [typeof declaredEvalSchema, typeof declaredGroupSchema, typeof declaredTodoSchema],
  'type'
> = z.discriminatedUnion('type', [declaredEvalSchema, declaredGroupSchema, declaredTodoSchema])

export const declarationTreeSchema = z.strictObject({ children: z.array(declaredNodeSchema) })

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof declaredModeSchema>, DeclaredMode>>,
  Assert<Same<z.infer<typeof declaredFamilySchema>, DeclaredFamily>>,
  Assert<Same<z.infer<typeof declaredSourceSchema>, DeclaredSource>>,
  Assert<Same<z.infer<typeof declaredTodoSchema>, DeclaredTodo>>,
  Assert<Same<z.infer<typeof declaredEvalSchema>, DeclaredEval>>,
  Assert<Same<z.infer<typeof declaredGroupSchema>, DeclaredGroup>>,
  Assert<Same<z.infer<typeof declaredNodeSchema>, DeclaredNode>>,
  Assert<Same<z.infer<typeof declarationTreeSchema>, DeclarationTree>>,
]

const NODE_SCHEMAS: Record<string, z.ZodObject> = {
  eval: declaredEvalSchema,
  group: declaredGroupSchema,
  todo: declaredTodoSchema,
}

/**
 * What's wrong with a declaration tree's shape, or undefined: the field, by its path from the
 * tree's `children`. Options are left to the cascade.
 */
export const declarationProblem = (children: unknown): string | undefined =>
  dataProblem(declarationTreeSchema, { children }, 'The declaration tree', (node) =>
    Object.keys(NODE_SCHEMAS[String(node.type)]?.shape ?? {}),
  )
