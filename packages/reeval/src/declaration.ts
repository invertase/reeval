// An eval file's declarations as data: its groups and evals, nested as declared, with their modes
// and raw options, and each eval's body by id. `evaluate` and `group` record it as they're called
// (evaluate.ts), and `declareTree` declares one, so whoever declares a file, `planEval` plans the
// same matrix from it. schema/plan/declaration.schema.json is its JSON Schema.
import type { EvalOptionsData } from './types.ts'

/** How a group or eval was declared: `group`/`evaluate`, `.skip` or `.only`. */
export type DeclaredMode = 'run' | 'skip' | 'only'

// Recorded from TypeScript, `options` can still hold the function forms (a harness edit function,
// an AI SDK judge model), which JSON can't carry.
export type DeclaredGroup = {
  type: 'group'
  name: string
  mode: DeclaredMode
  options: EvalOptionsData
  children: DeclaredNode[]
}

export type DeclaredEval = {
  type: 'eval'
  name: string
  mode: DeclaredMode
  options: EvalOptionsData
  /** Names the eval's body to whoever runs it. */
  body: string
  /** Set on each case of a pooled `evaluate.each`: its template, index and the list's length. */
  family?: DeclaredFamily
}

export type DeclaredFamily = { name: string; case: number; cases: number }

/** `evaluate.todo` or `group.todo`. */
export type DeclaredTodo = { type: 'todo'; name: string }

export type DeclaredNode = DeclaredGroup | DeclaredEval | DeclaredTodo

export type DeclarationTree = { children: DeclaredNode[] }
