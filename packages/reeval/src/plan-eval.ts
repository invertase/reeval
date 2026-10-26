// An eval's plan from its declaration alone: the options cascade, the profile and tags, the
// matrix, the egress, MCP and plugin refusals, and each attempt's gate. Pure but for reading local
// plugins: whoever declared the eval (an eval file's `evaluate`, or a declaration tree) registers
// what it returns.
import { type AttemptSpec, setupAllowance } from './attempt/index.ts'
import type { DeclaredFamily, DeclaredSource } from './declaration.ts'
import { MAX_TIMER_MS, parseDuration } from './duration.ts'
import { allowedHosts, unenforceable } from './egress.ts'
import type { Gate, TestMode } from './engine/runtime.ts'
import {
  buildRefusal,
  builtPlugins,
  duplicateLocalPlugin,
  fetchesAtStart,
  layeredPlugins,
  localPlugin,
  localSkills,
  type PluginContents,
  PluginProblem,
  pluginCall,
  pluginSourceLabel,
} from './environment/plugins.ts'
import { filesOf, workspaceOf } from './environment.ts'
import { UsageError } from './errors.ts'
import { optionsHash } from './eval-source.ts'
import { resolveModelGateway } from './gateway/models.ts'
import { openRouterFallbacks } from './gateway/openrouter-models.ts'
import { resolveGateway } from './gateway/resolve.ts'
import { vercelCredentialProblem } from './gateway/vercel.ts'
import { type VertexSettings, vertexSettings } from './gateway/vertex.ts'
import { refusedMcp, refusedPlugins } from './harness/agents.ts'
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
  plainHeaderError,
  plainHeaders,
  type Resolved,
  type ResolvedEval,
  sandboxProvider,
  sandboxSetBy,
  secretVarsIn,
  unbrokered,
  unbrokeredError,
} from './options.ts'
import type { Limits } from './scheduler/core.ts'
import type {
  AttemptMeta,
  EvalOptions,
  GroupOptions,
  ResolvedConfig,
  ResolvedGateway,
  RunContext,
} from './types.ts'

/** Lets the attempt's own eval timer fire before the engine's backstop, so the message and cleanup are its own. */
const GRACE_MS = 5_000

/** One eval as declared: its name, mode, enclosing groups (outermost first) and own options. */
export type EvalDeclaration = {
  name: string
  mode: TestMode
  groups: { name: string; options: GroupOptions }[]
  options: EvalOptions
  /** Hashes of its body and case data, from whoever declared it. */
  source: DeclaredSource
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
    question: config.question,
    questions: [],
    timeout: undefined,
    tags: [],
    revision: undefined,
    pin: [],
    sources: {},
  }
}

/** An eval's plan: its tests, and the harness ids it runs on before a profile's limit. */
export type PlannedEval = {
  /** `null` when the run's tags leave the eval out (it isn't counted in `order`). */
  tests: PlannedTest[] | null
  harnesses: string[]
}

/** The tests an eval registers. Throws a UsageError for options the plan refuses. */
export function planEval(declaration: EvalDeclaration, ctx: PlanContext): PlannedEval {
  const { name, groups: enclosing, options: own } = declaration
  const where = `evaluate("${[...enclosing.map((g) => g.name), name].join(' › ')}")`
  checkOptions(own, where)
  const levels: Level[] = [
    ...enclosing.map((g) => ({ options: g.options, where: `group("${g.name}")` })),
    { options: own, where },
  ]
  const resolvedEval = cascade(configLevel(ctx.config), levels, where, {
    profile: ctx.profile,
    runs: ctx.runs,
    skipped: declaration.mode === 'skip' || declaration.mode === 'todo',
  })
  const { harnesses } = resolvedEval
  if (!matchesTags(resolvedEval.resolved.tags, ctx.tags)) return { tests: null, harnesses }
  return { tests: planTests(declaration, ctx, where, resolvedEval), harnesses }
}

function planTests(
  declaration: EvalDeclaration,
  ctx: PlanContext,
  where: string,
  resolvedEval: ResolvedEval,
): PlannedTest[] {
  const { name, mode, groups: enclosing } = declaration
  const groups = enclosing.map((g) => g.name)
  const { resolved } = resolvedEval
  const source = {
    ...declaration.source,
    options: optionsHash([...enclosing.map((g) => g.options), declaration.options]),
  }
  const timeoutMs =
    resolved.timeout === undefined ? ctx.config.timeoutMs : parseDuration(resolved.timeout)
  const gateways = ctx.profile?.gateway ?? ctx.config.gateway
  const gatewaySet = ctx.config.gatewaySet || ctx.profile?.gateway !== undefined
  const routes = new Map<string, ResolvedGateway>()
  const gatewayNotes: string[] = []
  let vertex: VertexSettings | undefined
  // Each harness carries the gateway it resolved to, so the worker, egress and brokering read it
  // from the descriptor; direct leaves the descriptor as written.
  const routed = resolvedEval.skip
    ? resolved.harness
    : resolved.harness.map((harness) => {
        const route = resolveGateway(gateways, harness, where)
        const hid = harnessId(harness)
        if (gatewaySet || harness.gateway !== undefined) {
          routes.set(hid, route)
          gatewayNotes.push(
            `gateway: ${hid} → ${route.name}${route.name === 'direct' && route.skipped.length ? ' (fallback)' : ''}`,
          )
        }
        if (route.name === 'direct') return harness
        if (harness.kind !== 'fake') {
          try {
            if (route.name === 'vercel') {
              const problem = vercelCredentialProblem()
              if (problem) throw new UsageError(problem)
            }
            if (route.name === 'vertex') {
              const entry = gateways.find((g) => g.kind === 'vertex')
              vertex ??= vertexSettings(entry?.kind === 'vertex' ? entry : {})
            }
          } catch (error) {
            if (error instanceof UsageError) {
              throw new UsageError(`${where} on ${hid}: ${error.message}`)
            }
            throw error
          }
        }
        return { ...harness, gateway: route.name }
      })
  const plannedAttempts = resolvedEval.skip ? [] : expand({ ...resolved, harness: routed }, vertex)
  let judge: AttemptMeta['judge']
  if (plannedAttempts.length) {
    try {
      const gateway = resolveModelGateway(
        resolved.judge.model,
        resolved.judge.gateway,
        { gateways },
        'the judge model',
      )
      const { model } = resolved.judge
      if (typeof model === 'string') judge = { model, ...(gateway ? { gateway } : {}) }
    } catch (error) {
      if (error instanceof UsageError) throw new UsageError(`${where}: ${error.message}`)
      throw error
    }
  }
  if (ctx.config.secrets.unbrokered === 'error') {
    const [first] = unbrokered(resolved.env, plannedAttempts)
    if (first) throw new UsageError(unbrokeredError(first, where, ctx.config.file))
    const [plain] = plainHeaders(plannedAttempts)
    if (plain) throw new UsageError(plainHeaderError(plain, where, ctx.config.file))
  }
  const pluginNotes: string[] = []
  const pluginLabels = new Map<PlannedAttempt, string[]>()
  for (const planned of plannedAttempts) {
    const why = unenforceable(planned.egress, planned.sandbox, where)
    if (why) throw new UsageError(why)
    const on = `${where} on ${harnessId(planned.harness)}`
    const mcp = refusedMcp(planned.harness, planned.environment.layers)
    if (mcp) throw new UsageError(`${on}: ${mcp}`)
    const plugins = planPlugins(planned, ctx.config.root)
    if (plugins.refusal) throw new UsageError(`${on}: ${plugins.refusal}`)
    for (const note of plugins.notes) if (!pluginNotes.includes(note)) pluginNotes.push(note)
    if (plugins.labels.length) pluginLabels.set(planned, plugins.labels)
  }
  const path = ctx.file ? relativeFile(ctx.config.root, ctx.file) : null
  const rankFile = relativeFile(ctx.config.root, ctx.file ?? '')
  const family = declaration.family && {
    id: evalId(rankFile, [...groups, declaration.family.name]),
    ...declaration.family,
  }
  const harnessBy = resolved.sources?.harness ?? ctx.config.file
  const plan = evalPlan(resolvedEval, plannedAttempts, { configFile: ctx.config.file, file: path })
  // OpenRouter's fallbacks reach only reeval's own calls; the plan says so where they're on.
  if (gatewayNotes.length && openRouterFallbacks(gateways)) {
    gatewayNotes.push(
      "gateway: openrouter() fallbacks on: reeval's own calls may fail over to another upstream provider; the harnesses' calls take OpenRouter's own routing",
    )
  }
  plan.notes.push(...gatewayNotes, ...pluginNotes)
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
      ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
      source,
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
    const builds = builtPlugins(planned.environment.layers)
    const setBy = builds.length
      ? {
          ...setByOf(planned),
          pluginBuilds: `environment ${planned.environment.name}${path ? ` in ${path}` : ''}`,
        }
      : setByOf(planned)
    const id = evalId(rankFile, [...groups, name])
    const key = attemptKey(id, planned.cell.key, planned.n)
    const done = ctx.completed?.includes(key)
    const skip = done ? 'already completed in this run' : undefined
    const attempt: AttemptMeta = {
      name,
      groups,
      tags: resolved.tags,
      ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
      source,
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
      ...(pluginLabels.has(planned) ? { plugins: pluginLabels.get(planned) } : {}),
      ...(builds.length ? { pluginBuilds: builds } : {}),
      plan: skip ? { ...plan, skip } : plan,
      ...(skip ? { skip } : {}),
      ...(family ? { family } : {}),
      ...(routes.has(harnessId(planned.harness))
        ? { gateway: routes.get(harnessId(planned.harness)) }
        : {}),
      ...(judge ? { judge } : {}),
    }
    return {
      name: `${name} [${attemptId(planned.cell.key, planned.n)}]`,
      mode: skip ? 'skip' : mode,
      attempt,
      timeout: skip
        ? undefined
        : // A longer backstop would fire at once.
          Math.min(timeoutMs + setupAllowance(planned) + GRACE_MS, MAX_TIMER_MS),
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

/**
 * What the plan can tell of an attempt's plugins before any is fetched: a build outside Docker, a
 * local plugin's content, and the harness's refusal, as a refusal; the commands that fetch a
 * package at start, as notes under `proxy` and `allow-all`; and a label for each plugin. Git and npm plugins
 * are read when the attempt resolves its environment, which refuses them the same way.
 */
function planPlugins(
  planned: PlannedAttempt,
  root: string,
): { refusal?: string; notes: string[]; labels: string[] } {
  const { layers } = planned.environment
  const sources = layeredPlugins(layers)
  if (sources.length === 0) return { notes: [], labels: [] }
  const read: PluginContents[] = []
  const unread: string[] = []
  const labels: string[] = []
  for (const source of sources) {
    const call = pluginCall(source, root)
    const p = localPlugin(source, root)
    if (p instanceof PluginProblem) return { refusal: p.message, notes: [], labels }
    const build = buildRefusal(source, planned.sandbox, p?.name, root)
    if (build) return { refusal: build, notes: [], labels }
    if (p) read.push(p)
    else unread.push(call)
    labels.push(p ? `${p.name} (${p.kept.join(', ')})` : pluginSourceLabel(source, root))
  }
  const twice = duplicateLocalPlugin(layers, root)
  if (twice) return { refusal: twice, notes: [], labels }
  const own = {
    skills: localSkills(layers, root),
    mcp: [...new Set(layers.flatMap((l) => Object.keys(l.spec.mcp ?? {})))],
  }
  const refusal = refusedPlugins(planned.harness, read, own, unread)
  if (refusal) return { refusal, notes: [], labels }
  return { ...fetchesAtStart(read, allowedHosts(planned.egress)), labels }
}

/** The run-wide cap, plus the sandbox provider's and harness's own caps when they set one. */
function attemptLimits(planned: PlannedAttempt, concurrency: number): Limits {
  const limits: Limits = { attempts: concurrency }
  const { sandbox, harness } = planned
  if (sandbox.maxConcurrent) limits[`sandbox:${sandboxProvider(sandbox)}`] = sandbox.maxConcurrent
  if (harness.maxConcurrent) limits[`harness:${harness.kind}`] = harness.maxConcurrent
  return limits
}
