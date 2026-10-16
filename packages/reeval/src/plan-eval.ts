// An eval's plan from its declaration alone: the options cascade, the profile and tags, the
// matrix, the egress and MCP refusals, and each attempt's gate. Pure: whoever declared the eval
// (an eval file's `evaluate`, or a declaration tree) registers what it returns.
import { type AttemptSpec, setupAllowance } from './attempt/index.ts'
import type { DeclaredFamily } from './declaration.ts'
import { parseDuration } from './duration.ts'
import { unenforceable } from './egress.ts'
import type { Gate, TestMode } from './engine/runtime.ts'
import { filesOf, workspaceOf } from './environment.ts'
import { UsageError } from './errors.ts'
import { refusedMcp } from './harness/agents.ts'
import { attemptId, attemptKey, evalId, relativeFile } from './ids.ts'
import {
  brokeredIn,
  cascade,
  checkOptions,
  evalPlan,
  expand,
  harnessId,
  type Level,
  matchesTags,
  type PlannedAttempt,
  type Resolved,
  sandboxSetBy,
  secretVarsIn,
  unbrokered,
  unbrokeredError,
} from './options.ts'
import type { Limits } from './scheduler/core.ts'
import type { AttemptMeta, EvalOptions, GroupOptions, ResolvedConfig, RunContext } from './types.ts'

/** Lets the attempt's own eval timer fire before the engine's backstop, so the message and cleanup are its own. */
const GRACE_MS = 5_000

/** One eval as declared: its name, mode, enclosing groups (outermost first) and own options. */
export type EvalDeclaration = {
  name: string
  mode: TestMode
  groups: { name: string; options: GroupOptions }[]
  options: EvalOptions
  /** Set on each case of a pooled `evaluate.each`. */
  family?: DeclaredFamily
}

/** Where the eval is planned: the run, the eval file, and how many evals the file planned before it. */
export type PlanContext = Pick<
  RunContext,
  'config' | 'profile' | 'runs' | 'tags' | 'concurrency' | 'completed'
> & {
  /** The eval file's path, absolute. */
  file: string | undefined
  /** Its place among the file's planned evals, for the scheduler's tie-break. */
  order: number
}

/** One test to register: an attempt, or the one entry that stands for a skipped eval. */
export type PlannedTest = {
  name: string
  mode: TestMode
  attempt: AttemptMeta
  /** The engine's backstop timeout; none for a skipped eval. */
  timeout?: number
  /** What the attempt needs before it starts; none for a skipped eval. */
  gate?: Gate
  /** How the attempt runs; none for a skipped eval. */
  spec?: AttemptSpec
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
    capture: config.capture,
    timeout: undefined,
    tags: [],
    pin: [],
    sources: {},
  }
}

/**
 * The tests an eval registers, or `null` when the run's tags leave it out (it isn't counted in
 * `order`). Throws a UsageError for options the plan refuses.
 */
export function planEval(declaration: EvalDeclaration, ctx: PlanContext): PlannedTest[] | null {
  const { name, mode, groups: enclosing, options: own } = declaration
  const groups = enclosing.map((g) => g.name)
  const where = `evaluate("${[...groups, name].join(' › ')}")`
  checkOptions(own, where)
  const levels: Level[] = [
    ...enclosing.map((g) => ({ options: g.options, where: `group("${g.name}")` })),
    { options: own, where },
  ]
  const resolvedEval = cascade(configLevel(ctx.config), levels, where, {
    profile: ctx.profile,
    runs: ctx.runs,
  })
  const { resolved } = resolvedEval
  if (!matchesTags(resolved.tags, ctx.tags)) return null
  const timeoutMs =
    resolved.timeout === undefined ? ctx.config.timeoutMs : parseDuration(resolved.timeout)
  const plannedAttempts = resolvedEval.skip ? [] : expand(resolved)
  if (ctx.config.secrets.unbrokered === 'error') {
    const [first] = unbrokered(resolved.env, plannedAttempts)
    if (first) throw new UsageError(unbrokeredError(first, where, ctx.config.file))
  }
  for (const planned of plannedAttempts) {
    const why = unenforceable(planned.egress, planned.sandbox, where)
    if (why) throw new UsageError(why)
    const mcp = refusedMcp(planned.harness, planned.environment.layers)
    if (mcp) throw new UsageError(`${where} on ${harnessId(planned.harness)}: ${mcp}`)
  }
  const path = ctx.file ? relativeFile(ctx.config.root, ctx.file) : null
  const rankFile = relativeFile(ctx.config.root, ctx.file ?? '')
  const family = declaration.family && {
    id: evalId(rankFile, [...groups, declaration.family.name]),
    ...declaration.family,
  }
  const harnessBy = resolved.sources?.harness ?? ctx.config.file
  const plan = evalPlan(resolvedEval, plannedAttempts, { configFile: ctx.config.file, file: path })
  const setByOf = (planned: PlannedAttempt) => ({
    sandbox: sandboxSetBy(planned, resolved, ctx.config.file),
    harness: harnessBy,
  })
  if (resolvedEval.skip) {
    const [first] = expand(resolved)
    if (!first) return []
    const attempt: AttemptMeta = {
      name,
      groups,
      tags: resolved.tags,
      cell: first.cell,
      n: 1,
      label: '',
      harness: first.harness,
      sandbox: first.sandbox,
      setBy: setByOf(first),
      gate: 'none',
      brokered: [],
      secretVars: [],
      egress: first.egress,
      plan,
      ...(family ? { family } : {}),
    }
    return [{ name: `${name} [${attemptId(first.cell.key, 1)}]`, mode: 'skip', attempt }]
  }
  const cells: string[] = []
  return plannedAttempts.map((planned) => {
    if (!cells.includes(planned.cell.key)) cells.push(planned.cell.key)
    const workspace = workspaceOf(planned.environment.layers)
    const files = filesOf(planned.environment.layers)
    const setBy = setByOf(planned)
    const id = evalId(rankFile, [...groups, name])
    const key = attemptKey(id, planned.cell.key, planned.n)
    const done = ctx.completed?.includes(key)
    const skip = done ? 'already completed in this run' : undefined
    const attempt: AttemptMeta = {
      name,
      groups,
      tags: resolved.tags,
      cell: planned.cell,
      n: planned.n,
      label: planned.label,
      harness: planned.harness,
      sandbox: planned.sandbox,
      setBy,
      gate: planned.gate,
      ...(planned.minLift !== undefined ? { minLift: planned.minLift } : {}),
      brokered: brokeredIn(resolved.env, planned),
      secretVars: secretVarsIn(resolved.env, planned),
      egress: planned.egress,
      ...(workspace ? { workspace } : {}),
      ...(files.length ? { files } : {}),
      plan: skip ? { ...plan, skip } : plan,
      ...(skip ? { skip } : {}),
      ...(family ? { family } : {}),
    }
    return {
      name: `${name} [${attemptId(planned.cell.key, planned.n)}]`,
      mode: skip ? 'skip' : mode,
      attempt,
      timeout: skip ? undefined : timeoutMs + setupAllowance(planned) + GRACE_MS,
      gate: skip
        ? undefined
        : {
            limits: attemptLimits(planned, ctx.concurrency),
            rank: {
              eval: id,
              file: rankFile,
              order: ctx.order,
              n: planned.n,
              cell: cells.indexOf(planned.cell.key),
            },
          },
      spec: skip
        ? undefined
        : {
            ...planned,
            name,
            groups,
            timeoutMs,
            env: resolved.env,
            judge: resolved.judge,
            capture: resolved.capture,
            sources: { ...resolved.sources, sandbox: setBy.sandbox },
            notes: resolvedEval.notes,
          },
    }
  })
}

/** The run-wide cap, plus the sandbox provider's and harness's own caps when they set one. */
function attemptLimits(planned: PlannedAttempt, concurrency: number): Limits {
  const limits: Limits = { attempts: concurrency }
  const { sandbox, harness } = planned
  if (sandbox.maxConcurrent) limits[`sandbox:${sandbox.kind}`] = sandbox.maxConcurrent
  if (harness.maxConcurrent) limits[`harness:${harness.kind}`] = harness.maxConcurrent
  return limits
}
