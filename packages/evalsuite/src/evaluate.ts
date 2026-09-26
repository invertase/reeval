import { type AttemptSpec, runAttempt, setupAllowance } from './attempt/index.ts'
import { parseDuration } from './config.ts'
import { unenforceable } from './egress.ts'
import { getRunContext, registerGroup, registerTest, type TestMode } from './engine/runtime.ts'
import { inCI } from './env.ts'
import { UsageError } from './errors.ts'
import { attemptId, evalId, relativeFile } from './ids.ts'
import {
  brokeredIn,
  cascade,
  checkOptions,
  evalPlan,
  expand,
  type Level,
  matchesTags,
  type PlannedAttempt,
  type Resolved,
  unbrokered,
  unbrokeredError,
} from './options.ts'
import type { Limits } from './scheduler/core.ts'
import type {
  AttemptMeta,
  EvalContext,
  EvalFn,
  EvalOptions,
  GroupOptions,
  ResolvedConfig,
} from './types.ts'

export type { EvalOptions, GroupOptions }

/** Lets ES's own eval timer fire before Vitest's, so the message and cleanup are ours. */
const GRACE_MS = 5_000

// The groups enclosing the code being collected. Vitest may run a nested group's callback
// after its parent's callback has returned, so each group captures its parents when declared.
let groupStack: { name: string; options: GroupOptions }[] = []

/** `(name, fn)`, `(name, options, fn)` as in Vitest, or `(name, fn, options)`. */
function splitArgs<F extends (...args: never[]) => unknown>(
  what: string,
  name: string,
  a: EvalOptions | F | undefined,
  b: EvalOptions | F | undefined,
): [EvalOptions, F] {
  if (typeof a === 'function' && typeof b === 'function') {
    throw new UsageError(
      `${what}("${name}") got two functions. Options must be a plain object; helpers such as secret are only available in defineConfig and defineEnvironment callbacks. Put the secret in an environment (environment: …) or in the config's env.`,
    )
  }
  if (typeof a === 'function') return [(b as EvalOptions | undefined) ?? {}, a]
  if (typeof b === 'function') return [(a as EvalOptions | undefined) ?? {}, b]
  throw new TypeError(`${what}("${name}") needs a function`)
}

type GroupFn = {
  (name: string, fn: () => void, options?: GroupOptions): void
  (name: string, options: GroupOptions, fn: () => void): void
}

/** Vitest rejects `test.only` in CI but skips everything around a `describe.only`; ES rejects both. */
function checkOnly(mode: TestMode, what: string): void {
  if (mode !== 'only' || !inCI()) return
  const error = new Error(`${what}.only isn't allowed in CI`)
  error.name = 'OnlyInCiError'
  throw error
}

const defineGroup =
  (mode: TestMode): GroupFn =>
  (name: string, a?: GroupOptions | (() => void), b?: GroupOptions | (() => void)) => {
    checkOnly(mode, 'group')
    const [options, fn] = splitArgs<() => void>('group', name, a, b)
    checkOptions(options, `group("${name}")`)
    const stack = [...groupStack, { name, options }]
    registerGroup(name, mode, () => {
      const outer = groupStack
      groupStack = stack
      try {
        fn()
      } finally {
        groupStack = outer
      }
    })
  }

export const group: GroupFn & { skip: GroupFn; only: GroupFn; todo: (name: string) => void } =
  Object.assign(defineGroup('run'), {
    skip: defineGroup('skip'),
    only: defineGroup('only'),
    todo: (name: string) => registerGroup(name, 'todo', () => {}),
  })

type EvaluateFn<F = EvalFn> = {
  (name: string, fn: F, options?: EvalOptions): void
  (name: string, options: EvalOptions, fn: F): void
}

function configLevel(config: ResolvedConfig): Resolved {
  return {
    harness: config.harness,
    sandbox: config.sandbox,
    environment: config.environment,
    compare: undefined,
    runs: config.runs,
    gate: config.gate,
    env: config.env,
    egress: config.egress !== undefined ? { inherited: config.egress } : {},
    judge: config.judge,
    timeout: undefined,
    tags: [],
    pin: [],
    sources: {},
  }
}

function register(mode: TestMode, name: string, own: EvalOptions, fn: EvalFn): void {
  const groups = groupStack.map((g) => g.name)
  const where = `evaluate("${[...groups, name].join(' › ')}")`
  checkOptions(own, where)
  const ctx = getRunContext()
  const levels: Level[] = [
    ...groupStack.map((g) => ({ options: g.options, where: `group("${g.name}")` })),
    { options: own, where },
  ]
  const resolvedEval = cascade(configLevel(ctx.config), levels, where, {
    profile: ctx.profile,
    runs: ctx.runs,
  })
  const { resolved } = resolvedEval
  if (!matchesTags(resolved.tags, ctx.tags)) return
  const timeoutMs =
    resolved.timeout === undefined ? ctx.config.timeoutMs : parseDuration(resolved.timeout)
  const order = registered++
  const plannedAttempts = resolvedEval.skip ? [] : expand(resolved)
  if (ctx.config.secrets.unbrokered === 'error') {
    const [first] = unbrokered(resolved.env, plannedAttempts)
    if (first) throw new UsageError(unbrokeredError(first, where))
  }
  for (const planned of plannedAttempts) {
    const why = unenforceable(planned.egress, planned.sandbox, where)
    if (why) throw new UsageError(why)
  }
  const plan = evalPlan(resolvedEval, plannedAttempts)
  if (resolvedEval.skip) {
    const [first] = expand(resolved)
    if (!first) return
    const attempt: AttemptMeta = {
      name,
      groups,
      tags: resolved.tags,
      cell: first.cell,
      n: 1,
      label: '',
      harness: first.harness,
      sandbox: first.sandbox,
      gate: 'none',
      brokered: [],
      egress: first.egress,
      plan,
    }
    registerTest(
      `${name} [${attemptId(first.cell.key, 1)}]`,
      { mode: 'skip', attempt },
      async () => {},
    )
    return
  }
  const cells: string[] = []
  for (const planned of plannedAttempts) {
    if (!cells.includes(planned.cell.key)) cells.push(planned.cell.key)
    const attempt: AttemptMeta = {
      name,
      groups,
      tags: resolved.tags,
      cell: planned.cell,
      n: planned.n,
      label: planned.label,
      harness: planned.harness,
      sandbox: planned.sandbox,
      gate: planned.gate,
      ...(planned.minLift !== undefined ? { minLift: planned.minLift } : {}),
      brokered: brokeredIn(resolved.env, planned),
      egress: planned.egress,
      plan,
    }
    const spec: AttemptSpec = {
      ...planned,
      name,
      groups,
      timeoutMs,
      env: resolved.env,
      judge: resolved.judge,
      sources: resolved.sources ?? {},
      notes: resolvedEval.notes,
    }
    const cell = cells.indexOf(planned.cell.key)
    registerTest(
      `${name} [${attemptId(planned.cell.key, planned.n)}]`,
      {
        timeout: timeoutMs + setupAllowance(planned) + GRACE_MS,
        mode,
        attempt,
        gate: (file) => {
          const path = relativeFile(ctx.config.root, file)
          return {
            limits: attemptLimits(planned, ctx.concurrency),
            rank: { eval: evalId(path, [...groups, name]), file: path, order, n: planned.n, cell },
          }
        },
      },
      (handle) => runAttempt(spec, fn, handle),
    )
  }
}

/** Evals registered so far in this worker, for the scheduler's tie-break. */
let registered = 0

/** The run-wide cap, plus the sandbox provider's and harness's own caps when they set one. */
function attemptLimits(planned: PlannedAttempt, concurrency: number): Limits {
  const limits: Limits = { attempts: concurrency }
  const { sandbox, harness } = planned
  if (sandbox.maxConcurrent) limits[`sandbox:${sandbox.kind}`] = sandbox.maxConcurrent
  if (harness.maxConcurrent) limits[`harness:${harness.kind}`] = harness.maxConcurrent
  return limits
}

const defineEval =
  (mode: TestMode): EvaluateFn =>
  (name: string, a?: EvalOptions | EvalFn, b?: EvalOptions | EvalFn) => {
    checkOnly(mode, 'evaluate')
    const [own, fn] = splitArgs<EvalFn>('evaluate', name, a, b)
    register(mode, name, own, fn)
  }

/** `$key` is a property of the case, `%s` the case itself, `%#` its index. */
function formatName(template: string, item: unknown, index: number): string {
  return template
    .replace(/%#/g, String(index))
    .replace(/%s/g, typeof item === 'string' ? item : JSON.stringify(item))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, key: string) =>
      typeof item === 'object' && item !== null && key in item
        ? String((item as Record<string, unknown>)[key])
        : whole,
    )
}

/** One eval per case: `evaluate.for(cases)('adds $a and $b', async (t, c) => …)`. */
const evalFor =
  <T>(cases: readonly T[]): EvaluateFn<(t: EvalContext, item: T) => Promise<void>> =>
  (name: string, a?: unknown, b?: unknown) => {
    const [own, fn] = splitArgs<(t: EvalContext, item: T) => Promise<void>>(
      'evaluate.for',
      name,
      a as EvalOptions,
      b as EvalOptions,
    )
    cases.forEach((item, i) => {
      register('run', formatName(name, item, i), own, (t) => fn(t, item))
    })
  }

export const evaluate: EvaluateFn & {
  skip: EvaluateFn
  only: EvaluateFn
  todo: (name: string) => void
  for: typeof evalFor
} = Object.assign(defineEval('run'), {
  skip: defineEval('skip'),
  only: defineEval('only'),
  todo: (name: string) => {
    const tags = [...new Set(groupStack.flatMap((g) => g.options.tags ?? []))]
    if (matchesTags(tags, getRunContext().tags))
      registerTest(name, { mode: 'todo' }, async () => {})
  },
  for: evalFor,
})
