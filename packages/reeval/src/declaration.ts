// An eval file's declarations as data: its groups and evals, nested as declared, with their modes
// and raw options, and each eval's body by id. `evaluate` and `group` record it as they're called
// (evaluate.ts), and `declareTree` declares one, so whoever declares a file, `planEval` plans the
// same matrix from it. schema/plan/declaration.schema.json is its JSON Schema.
import type { EvalOptionsData } from './types.ts'

/** How a group or eval was declared: `group`/`evaluate`, `.skip` or `.only`. */
export type DeclaredMode = 'run' | 'skip' | 'only'

// Recorded from TypeScript, `options` can still hold the function forms (a harness edit function,
// an AI SDK judge model), which JSON can't carry.
/** A `group`: options its evals and groups inherit, and its children in declaration order. */
export type DeclaredGroup = {
  type: 'group'
  /** The group's name, as passed to `group`. */
  name: string
  mode: DeclaredMode
  /** The group's own options, before the cascade. */
  options: EvalOptionsData
  children: DeclaredNode[]
}

/** An `evaluate`: one eval, planned into a test per attempt. */
export type DeclaredEval = {
  type: 'eval'
  /** The eval's name, as passed to `evaluate` (a case's, for `evaluate.each`). */
  name: string
  mode: DeclaredMode
  /** The eval's own options, before the cascade. */
  options: EvalOptionsData
  /** Names the eval's body to whoever runs it. */
  body: string
  /** Set on each case of a pooled `evaluate.each`: its template, index and the list's length. */
  family?: DeclaredFamily
}

/** Where a case of a pooled `evaluate.each` sits in its list. */
export type DeclaredFamily = {
  /** The name template passed to `evaluate.each`. */
  name: string
  /** The case's index, from 0. */
  case: number
  /** How many cases the list has. */
  cases: number
}

/** `evaluate.todo` or `group.todo`. */
export type DeclaredTodo = {
  type: 'todo'
  /** The name passed to `.todo`. */
  name: string
}

/** One node of the tree: a group, an eval or a todo. */
export type DeclaredNode = DeclaredGroup | DeclaredEval | DeclaredTodo

/** An eval file's top-level groups, evals and todos, in declaration order. */
export type DeclarationTree = { children: DeclaredNode[] }
