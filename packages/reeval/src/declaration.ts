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
  /** The eval's name, as passed to `evaluate` (a case's, for an eval with `cases`). */
  name: string
  mode: DeclaredMode
  /** The eval's own options, before the cascade. */
  options: EvalOptionsData
  /** Names the eval's body to whoever runs it. */
  body: string
  source: DeclaredSource
  /** Set on each case of an eval with `cases`: its template, index and the list's length. */
  family?: DeclaredFamily
}

/**
 * An eval's own source, hashed by the SDK that declared it: sha256 (hex) of its body's source
 * text, and of a case's data as canonical JSON (object keys sorted, no
 * whitespace, non-ASCII characters as themselves).
 */
export type DeclaredSource = {
  /** sha256 of the body function's source text. */
  body: string
  /** sha256 of the case's data; set on each case of an eval with `cases`. */
  case?: string
}

/** Where a case of an eval with `cases` sits in its list. */
export type DeclaredFamily = {
  /** The name template the eval's own name. */
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
