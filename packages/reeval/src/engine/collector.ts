// The eval file's tree of groups and attempts, as `evaluate` and `group` declare it, and which
// of them run. It follows Vitest's collector: a group's body runs after the code around it (the
// file's top level first, then each group in order), and `.only` narrows its own file only.
import { UsageError } from '../errors.ts'
import type { TestHandle, TestMode, TestOptions } from './runtime.ts'

type Suite = {
  type: 'suite'
  name: string
  mode: TestMode
  factory?: () => unknown
  tasks: Task[]
  containsOnly: boolean
}

/** One registered test: an attempt, a skipped eval or a placeholder. */
export type CollectedTest = {
  type: 'test'
  /** Its place in the file, in declaration order. */
  index: number
  name: string
  /** The enclosing groups, outermost first. */
  groups: string[]
  /** After `.only`, `.skip` and `.todo` are applied: `only` only inside a skipped group. */
  mode: TestMode
  options: TestOptions
  body: (handle: TestHandle) => Promise<void>
}

type Task = Suite | CollectedTest

let collecting: { file: string; current: Suite } | undefined

export const collectingFile = (): string | undefined => collecting?.file

export function registerGroup(name: string, mode: TestMode, factory: () => void): void {
  current().tasks.push({ type: 'suite', name, mode, factory, tasks: [], containsOnly: false })
}

export function registerTest(
  name: string,
  options: TestOptions,
  body: (handle: TestHandle) => Promise<void>,
): void {
  current().tasks.push({
    type: 'test',
    index: -1,
    name,
    groups: [],
    mode: options.mode,
    options,
    body,
  })
}

function current(): Suite {
  if (!collecting)
    throw new UsageError(
      "evaluate() and group() declare evals while ES loads the file; they can't be called inside an eval.",
    )
  return collecting.current
}

/** Loads the file with `load` and returns its tests in declaration order, with their modes. */
export async function collect(
  file: string,
  load: () => Promise<unknown>,
): Promise<CollectedTest[]> {
  const root: Suite = { type: 'suite', name: '', mode: 'run', tasks: [], containsOnly: false }
  collecting = { file, current: root }
  try {
    await load()
    await collectSuite(root)
  } finally {
    collecting = undefined
  }
  interpretModes(root, root.containsOnly, false)
  const tests: CollectedTest[] = []
  const walk = (suite: Suite, groups: string[]) => {
    for (const task of suite.tasks) {
      if (task.type === 'suite') walk(task, [...groups, task.name])
      else tests.push(Object.assign(task, { index: tests.length, groups }))
    }
  }
  walk(root, [])
  return tests
}

async function collectSuite(suite: Suite): Promise<void> {
  const state = collecting as { current: Suite }
  if (suite.factory) {
    const outer = state.current
    state.current = suite
    try {
      await suite.factory()
    } finally {
      state.current = outer
    }
  }
  for (const task of suite.tasks) if (task.type === 'suite') await collectSuite(task)
  suite.containsOnly = suite.tasks.some(
    (t) => t.mode === 'only' || (t.type === 'suite' && t.containsOnly),
  )
}

/** Vitest's `interpretTaskModes`, without the filters ES applies itself. */
function interpretModes(suite: Suite, onlyMode: boolean, parentIsOnly: boolean): void {
  const suiteIsOnly = parentIsOnly || suite.mode === 'only'
  const someOnly = onlyMode && suite.containsOnly
  for (const t of suite.tasks) {
    const include = someOnly
      ? t.mode === 'only' || (t.type === 'suite' && t.containsOnly)
      : suiteIsOnly || t.mode === 'only'
    if (onlyMode) {
      if (t.type === 'suite' && (include || t.containsOnly)) {
        if (t.mode === 'only') t.mode = 'run'
      } else if (t.mode === 'run' && !include) t.mode = 'skip'
      else if (t.mode === 'only') t.mode = 'run'
    }
    if (t.type === 'suite') {
      if (t.mode === 'skip' || t.mode === 'todo') markAll(t, t.mode)
      else interpretModes(t, onlyMode, include)
    }
  }
}

function markAll(suite: Suite, mode: 'skip' | 'todo'): void {
  for (const t of suite.tasks) {
    if (t.mode !== 'run') continue
    t.mode = mode
    if (t.type === 'suite') markAll(t, mode)
  }
}
