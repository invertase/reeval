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
  DeclaredTodo,
} from '../declaration.ts'
import type { EvalOptionsData } from '../types.ts'
import {
  type Assert,
  closest,
  fieldPath,
  genericProblem,
  got,
  type Issue,
  oneOf,
  type Same,
  valueAt,
} from './shared.ts'

/** A node's options: any object, until the cascade checks it. Its JSON Schema is the type's. */
export const evalOptionsDataSchema = z.record(
  z.string(),
  z.unknown(),
) as unknown as z.ZodType<EvalOptionsData>

export const declaredModeSchema = z
  .enum(['run', 'skip', 'only'])
  .describe('How a group or eval was declared: `group`/`evaluate`, `.skip` or `.only`.')

export const declaredFamilySchema = z
  .strictObject({
    name: z.string().describe('The name template passed to `evaluate.each`.'),
    case: z.number().int().min(0).describe("The case's index, from 0."),
    cases: z.number().int().min(2).describe('How many cases the list has.'),
  })
  .describe('Where a case of a pooled `evaluate.each` sits in its list.')

export const declaredTodoSchema = z
  .strictObject({
    type: z.literal('todo'),
    name: z.string().describe('The name passed to `.todo`.'),
  })
  .describe('`evaluate.todo` or `group.todo`.')

export const declaredEvalSchema = z
  .strictObject({
    type: z.literal('eval'),
    name: z
      .string()
      .describe("The eval's name, as passed to `evaluate` (a case's, for `evaluate.each`)."),
    mode: declaredModeSchema,
    options: evalOptionsDataSchema.describe("The eval's own options, before the cascade."),
    body: z.string().describe("Names the eval's body to whoever runs it."),
    family: declaredFamilySchema
      .optional()
      .describe(
        "Set on each case of a pooled `evaluate.each`: its template, index and the list's length.",
      ),
  })
  .describe('An `evaluate`: one eval, planned into a test per attempt.')

export const declaredGroupSchema = z
  .strictObject({
    type: z.literal('group'),
    name: z.string().describe("The group's name, as passed to `group`."),
    mode: declaredModeSchema,
    options: evalOptionsDataSchema.describe("The group's own options, before the cascade."),
    get children(): z.ZodArray<typeof declaredNodeSchema> {
      return z.array(declaredNodeSchema)
    },
  })
  .describe(
    'A `group`: options its evals and groups inherit, and its children in declaration order.',
  )

export const declaredNodeSchema: z.ZodDiscriminatedUnion<
  [typeof declaredEvalSchema, typeof declaredGroupSchema, typeof declaredTodoSchema],
  'type'
> = z
  .discriminatedUnion('type', [declaredEvalSchema, declaredGroupSchema, declaredTodoSchema])
  .describe('One node of the tree: a group, an eval or a todo.')

export const declarationTreeSchema = z
  .strictObject({ children: z.array(declaredNodeSchema) })
  .describe("An eval file's top-level groups, evals and todos, in declaration order.")

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof declaredModeSchema>, DeclaredMode>>,
  Assert<Same<z.infer<typeof declaredFamilySchema>, DeclaredFamily>>,
  Assert<Same<z.infer<typeof declaredTodoSchema>, DeclaredTodo>>,
  Assert<Same<z.infer<typeof declaredEvalSchema>, DeclaredEval>>,
  Assert<Same<z.infer<typeof declaredGroupSchema>, DeclaredGroup>>,
  Assert<Same<z.infer<typeof declaredNodeSchema>, DeclaredNode>>,
  Assert<Same<z.infer<typeof declarationTreeSchema>, DeclarationTree>>,
]

const NODE_TYPES = ['group', 'eval', 'todo']

const NODE_SCHEMAS: Record<string, z.ZodObject> = {
  eval: declaredEvalSchema,
  group: declaredGroupSchema,
  todo: declaredTodoSchema,
}

/**
 * What's wrong with a declaration tree's shape, or undefined: the field, by its path from the
 * tree's `children`. An unknown key comes first, since it's usually a typo of a missing one.
 * Options are left to the cascade.
 */
export function declarationProblem(children: unknown): string | undefined {
  const tree = { children }
  const result = declarationTreeSchema.safeParse(tree)
  if (result.success) return undefined
  const { issues } = result.error
  const issue = issues.find((i) => i.code === 'unrecognized_keys') ?? (issues[0] as Issue)
  if (issue.code === 'invalid_union') {
    return `The declaration tree's ${fieldPath(issue.path)} is ${oneOf(NODE_TYPES)} (got ${got(valueAt(tree, issue.path))})`
  }
  if (issue.code === 'unrecognized_keys') {
    const node = valueAt(tree, issue.path) as { type?: string }
    const keys = Object.keys(NODE_SCHEMAS[String(node.type)]?.shape ?? { name: 0 })
    const near = closest(issue.keys[0] as string, keys)
    const hint = near ? `. Did you mean "${near}"?` : ''
    return `The declaration tree's ${genericProblem('', issue, tree)}${hint}`
  }
  return `The declaration tree's ${genericProblem('', issue, tree)}`
}
