import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDuration } from './config.ts'
import { diffSinceSnapshot, snapshot } from './diff.ts'
import {
  getRunContext,
  registerGroup,
  registerTest,
  type TestHandle,
  type TestMode,
} from './engine/runtime.ts'
import { inCI } from './env.ts'
import {
  type ResolvedEnvironment,
  type ResolvedStep,
  resolveEnvironment,
  skillFiles,
} from './environment/resolve.ts'
import { isTimeout, UsageError } from './errors.ts'
import { createHarness, workspaceSkillDir } from './harness/index.ts'
import type { HarnessSession } from './harness/types.ts'
import { attemptId, attemptKey, evalId, recordFileName, relativeFile } from './ids.ts'
import { type JudgeState, judgeModelName, runJudge } from './judge/index.ts'
import { changedFilesForJudge, patchForJudge } from './judge/patch.ts'
import type { RetriedError } from './judge/retry.ts'
import {
  cascade,
  checkOptions,
  evalPlan,
  expand,
  type Level,
  matchesTags,
  type PlannedAttempt,
  type Resolved,
} from './options.ts'
import { redactSecrets } from './redact.ts'
import { createSandbox, InfraError, type Sandbox } from './sandbox/index.ts'
import { withLease } from './scheduler/client.ts'
import type { Limits } from './scheduler/core.ts'
import { clip, formatDuration } from './text.ts'
import type {
  AttemptMeta,
  Diff,
  EnvVars,
  ErrorKind,
  EvalContext,
  EvalFn,
  EvalMeta,
  EvalOptions,
  EvalRecord,
  GroupOptions,
  JSONValue,
  JudgeInput,
  JudgeOptions,
  ResolvedConfig,
  Turn,
} from './types.ts'
import type { ProgressUpdate } from './ui/events.ts'

export type { EvalOptions, GroupOptions }

/** Extra time an attempt gets, outside its eval timeout, when its image may need building. */
const SETUP_BUDGET_MS = 20 * 60_000
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
    env: config.env,
    judge: config.judge,
    timeout: undefined,
    tags: [],
    pin: [],
  }
}

/** Setup steps run outside the eval timeout, so the attempt's own limit makes room for them. */
function setupAllowance(planned: PlannedAttempt): number {
  const layers = planned.environment.layers
  const steps = layers.flatMap((l) => l.spec.setup ?? [])
  const setupMs = steps.reduce(
    (ms, step) => ms + parseDuration((typeof step === 'string' ? undefined : step.timeout) ?? '5m'),
    0,
  )
  const baked = layers.some((l) => (l.spec.image ?? []).length > 0)
  const building = planned.sandbox.kind === 'docker' && (planned.sandbox.from || baked)
  return setupMs + (building ? SETUP_BUDGET_MS : 0)
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
      gated: false,
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
      gated: planned.gated,
      ...(planned.minLift !== undefined ? { minLift: planned.minLift } : {}),
      plan,
    }
    const spec: AttemptSpec = {
      ...planned,
      name,
      groups,
      timeoutMs,
      env: resolved.env,
      judge: resolved.judge,
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

function classify(error: unknown, signal: AbortSignal): { kind: ErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
    return isTimeout(reason)
      ? { kind: 'timeout', message: 'The eval timed out' }
      : { kind: 'aborted', message: 'The run was cancelled' }
  }
  if (error instanceof InfraError) return { kind: 'infra', message }
  return { kind: 'assertion', message }
}

/**
 * Skills, rules and MCP config the agent could load, with content hashes (never contents).
 * Paths under the home directory are shown as `~/…`; others are relative to the workspace.
 */
const CONTEXT_PATHS = [
  '$HOME/.cursor/mcp.json',
  '$HOME/.cursor/cli-config.json',
  '$HOME/.cursor/rules',
  '$HOME/.cursor/skills',
  '$HOME/.cursor/skills-cursor',
  '$HOME/.agents/skills',
  '$HOME/.claude/skills',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.cursor/rules',
  '.cursor/skills',
  '.cursor/mcp.json',
  '.agents/skills',
  '.mcp.json',
]

async function agentContext(box: Sandbox, signal: AbortSignal): Promise<EvalRecord['context']> {
  const script = `for p in ${CONTEXT_PATHS.map((p) => `"${p}"`).join(' ')}; do [ -e "$p" ] && find "$p" -type f 2>/dev/null; done | sort | head -500 | while IFS= read -r f; do printf '%s\t%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done`
  const r = await box.exec(script, { signal }).catch(() => null)
  if (r?.exitCode !== 0) return []
  const home = (await box.exec('printf %s "$HOME"', { signal }).catch(() => null))?.stdout ?? ''
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t')
      const path = rest.join('\t')
      return {
        path: home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path,
        sha256: sha ?? '',
      }
    })
}

const isTurn = (value: unknown): value is Turn =>
  typeof value === 'object' && value !== null && 'transcript' in value && 'diff' in value

function judgeState(turn: Turn, output: JSONValue = turn.text): JudgeState {
  return {
    task: turn.prompt,
    output,
    files: changedFilesForJudge(turn.diff.files),
    diff: patchForJudge(turn.diff.patch),
  }
}

type AttemptSpec = PlannedAttempt & {
  name: string
  groups: string[]
  timeoutMs: number
  env: EnvVars
  judge: JudgeOptions
}

const NO_JUDGE_MODEL =
  "t.judge() has no model. Set judge: { model: 'typesafe-ai/jev-1.13.0' } in es.config.ts, " +
  'on the group or eval, or pass { model } to this call.'

const tailOf = (text: string) => text.trim().split('\n').slice(-10).join('\n')

/** The eval's timer, paused while the sandbox and its setup steps start. */
function evalTimer(ms: number) {
  const controller = new AbortController()
  let left = ms
  let since = Date.now()
  let timer: NodeJS.Timeout | undefined
  const fire = () =>
    controller.abort(new DOMException(`Eval timed out after ${ms / 1000}s`, 'TimeoutError'))
  const start = () => {
    since = Date.now()
    timer = setTimeout(fire, Math.max(0, left))
  }
  start()
  return {
    signal: controller.signal,
    pause() {
      clearTimeout(timer)
      left -= Date.now() - since
    },
    resume: start,
    clear: () => clearTimeout(timer),
  }
}

async function runAttempt(
  spec: AttemptSpec,
  fn: EvalFn,
  { file, signal: testSignal, setMeta, progress }: TestHandle,
): Promise<void> {
  const report = (update: ProgressUpdate) => progress({ at: Date.now(), ...update })
  const setupStart = performance.now()
  const { runId, stagingDir, config } = getRunContext()
  const id = evalId(relativeFile(config.root, file), [...spec.groups, spec.name])
  const record: EvalRecord = {
    outcome: 'pass',
    error: null,
    turns: [],
    diff: null,
    checks: [],
    judgements: [],
    timings: { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
    judgeInputs: [],
  }
  const timed = async <T>(phase: keyof EvalRecord['timings'], fn: () => Promise<T>): Promise<T> => {
    const start = performance.now()
    try {
      return await fn()
    } finally {
      record.timings[phase] += Math.round(performance.now() - start)
    }
  }
  const turns: Turn[] = []
  let sandbox: Sandbox | undefined
  let session: HarnessSession | undefined
  let judgeErrored = false
  // Setup (environment, image build) runs on the test's signal; the eval timer starts after it.
  let signal = testSignal
  let timer: AbortSignal | undefined
  let clock: ReturnType<typeof evalTimer> | undefined
  const destroy = () => void sandbox?.destroy()
  testSignal.addEventListener('abort', destroy, { once: true })

  let resolved: ResolvedEnvironment | undefined
  let image: string | undefined
  async function setup() {
    const where = `${id} [${attemptId(spec.cell.key, spec.n)}]`
    resolved = await resolveEnvironment(spec.environment, spec.env, config.root, where)
    record.environment = resolved.record
    const secrets = resolved.record.secrets
    record.env = {
      vars: Object.keys(resolved.vars)
        .filter((n) => !secrets.includes(n))
        .sort(),
      secrets,
    }
    record.image = null
    if (spec.sandbox.kind === 'docker') {
      const { prepareImage } = await import('./sandbox/prepare.ts')
      record.image = await prepareImage(spec.sandbox, resolved.image, config.root, testSignal)
      image = record.image.ref
    }
  }
  const checkEnv = () => (resolved?.checkVars ?? {}) as Record<string, string>

  const requireSandbox = () => {
    if (!sandbox) throw new Error('No sandbox yet: call t.send() before t.exec() or t.readFile()')
    return sandbox
  }
  const exec = async (command: string) => {
    const box = requireSandbox()
    const start = performance.now()
    report({ kind: 'check-start', command })
    const r = await timed('checksMs', () => box.exec(command, { signal, env: checkEnv() }))
    const durationMs = Math.round(performance.now() - start)
    record.checks.push({ command, ...r, durationMs })
    report({ kind: 'check-end', command, exitCode: r.exitCode, ms: durationMs })
    return r
  }
  const readFile = (path: string) => requireSandbox().readFile(path)

  /** Setup steps in order, each with its own timeout; a failure is an infra error. */
  async function runSetup(box: Sandbox, env: ResolvedEnvironment) {
    const steps: ResolvedStep[] = [
      // The fake sandbox has no image to bake into, so it runs image steps here too.
      ...(spec.sandbox.kind === 'docker'
        ? []
        : env.image.map((s) => ({ run: s.run, timeoutMs: s.timeoutMs ?? 5 * 60_000 }))),
      ...env.setup,
    ]
    record.setup = []
    for (const [i, step] of steps.entries()) {
      const start = performance.now()
      const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(step.timeoutMs)])
      const r = await box
        .exec(step.run, {
          signal: stepSignal,
          env: env.checkVars,
          ...(step.cwd ? { cwd: step.cwd } : {}),
        })
        .catch((error) => {
          if (signal.aborted) throw error
          return null
        })
      const durationMs = Math.round(performance.now() - start)
      const output = r ? [r.stdout, r.stderr].filter(Boolean).join('\n') : ''
      record.setup.push({ run: step.run, exitCode: r?.exitCode ?? null, durationMs, output })
      if (r?.exitCode === 0) continue
      const what = `setup step ${i + 1}/${steps.length} "${clip(step.run, 80)}" in environment ${spec.environment.name}`
      throw new InfraError(
        r
          ? `${what} exited ${r.exitCode} after ${formatDuration(durationMs)} (see setup.log):\n${tailOf(r.stderr || r.stdout)}`
          : `${what} timed out after ${formatDuration(step.timeoutMs)} (see setup.log)`,
      )
    }
  }

  async function startSession(): Promise<[Sandbox, HarnessSession]> {
    const env = resolved as ResolvedEnvironment
    const box = await createSandbox(spec.sandbox, {
      runId,
      timeoutMs: spec.timeoutMs + setupAllowance(spec) + 60_000,
      signal,
      env: env.vars,
      image,
      brokerCredentials: spec.harness.kind === 'cursor',
    })
    sandbox = box
    if (signal.aborted) destroy()
    signal.throwIfAborted()
    for (const f of env.files) await box.writeFile(f.path, f.content)
    const skillDir = workspaceSkillDir(spec.harness)
    for (const skill of env.workspaceSkills) {
      for (const f of skillFiles(skill)) {
        await box.writeFile(`${skillDir}/${skill.name}/${f.path}`, f.content)
      }
    }
    await runSetup(box, env)
    await snapshot(box, signal)
    if (spec.sandbox.kind === 'docker') record.context = await agentContext(box, signal)
    const harness = await createHarness(spec.harness)
    session = await harness.start(box, signal, {
      skills: env.skills,
      workspaceSkills: env.workspaceSkills.map((s) => s.name),
      mcp: env.mcp,
    })
    report({ kind: 'sandbox-ready', ms: Math.round(performance.now() - setupStart) })
    return [box, session]
  }

  const t: EvalContext = {
    get signal() {
      return signal
    },
    turns,
    exec,
    readFile,
    attempt: { id: attemptId(spec.cell.key, spec.n), cell: spec.cell, n: spec.n },
    async send(prompt) {
      let started: [Sandbox, HarnessSession]
      if (sandbox && session) started = [sandbox, session]
      else {
        clock?.pause()
        try {
          started = await timed('setupMs', startSession)
        } finally {
          clock?.resume()
        }
      }
      const [box, agent] = started
      const entry = {
        prompt,
        text: '',
        status: 'error' as const,
        transcript: [],
        startedAt: new Date().toISOString(),
        durationMs: 0,
      }
      record.turns.push(entry)
      const turnNumber = record.turns.length
      report({ kind: 'turn-start', turn: turnNumber })
      const { raw, ...result } = await timed('agentMs', () => agent.send(prompt, signal))
      Object.assign(entry, result, raw ? { raw } : {})
      const count = (...types: string[]) =>
        result.transcript.filter((e) => types.includes(e.type)).length
      report({
        kind: 'turn-end',
        turn: turnNumber,
        status: result.status,
        ms: result.durationMs,
        tools: count('tool', 'web-search', 'web-fetch'),
        fileEdits: count('file-edit'),
      })
      signal.throwIfAborted()
      const diff: Diff = await timed('diffMs', () => diffSinceSnapshot(box, signal))
      record.diff = diff
      const turn: Turn = Object.freeze({ prompt, ...result, diff, exec, readFile })
      turns.push(turn)
      return turn
    },
    async judge(question, { on, ...call } = {}) {
      const subject = isTurn(on) ? on : turns.at(-1)
      if (!subject) throw new Error('t.judge() has no turn to grade: call t.send() first')
      const options = { ...spec.judge, ...call }
      const { model } = options
      if (model === undefined) {
        judgeErrored = true
        throw new Error(NO_JUDGE_MODEL)
      }
      const state = judgeState(subject, on === undefined || isTurn(on) ? undefined : on)
      const input: JudgeInput = { question, model: judgeModelName(model), state }
      record.judgeInputs?.push(input)
      const start = performance.now()
      const ms = () => Math.round(performance.now() - start)
      report({ kind: 'judge-start', question })
      const { maxConcurrent, ...judgeOptions } = options
      const provider = judgeModelName(model).split('/')[0]
      try {
        const { verdict, retries } = await timed('judgeMs', () =>
          withLease(
            maxConcurrent ? { [`judge:${provider}`]: maxConcurrent } : {},
            () =>
              runJudge(
                question,
                state,
                { ...judgeOptions, model, threshold: options.threshold ?? 0.8 },
                signal,
              ),
            signal,
          ),
        )
        record.judgements.push(retries.length ? { ...verdict, retries } : verdict)
        const { score, threshold } = verdict
        report({
          kind: 'judge-end',
          question,
          verdict: verdict.verdict,
          score,
          threshold,
          ms: ms(),
        })
        return verdict
      } catch (error) {
        judgeErrored = true
        const { retries } = error as Partial<RetriedError>
        input.error = error instanceof Error ? error.message : String(error)
        if (retries?.length) input.retries = retries
        report({
          kind: 'judge-end',
          question,
          verdict: 'error',
          score: null,
          threshold: null,
          ms: ms(),
        })
        throw error
      }
    },
  }

  const timedOut = () => !!timer?.aborted && !testSignal.aborted
  try {
    report({ kind: 'sandbox' })
    await timed('setupMs', setup)
    clock = evalTimer(spec.timeoutMs)
    timer = clock.signal
    signal = AbortSignal.any([testSignal, timer])
    timer.addEventListener('abort', destroy, { once: true })
    await fn(t)
    // A body that ignores the signal can still return normally after a timeout or cancel.
    signal.throwIfAborted()
  } catch (error) {
    record.error = timedOut()
      ? { kind: 'timeout', message: 'The eval timed out' }
      : classify(error, signal)
    const judgeFailed = judgeErrored || record.judgements.some((j) => j.verdict !== 'pass')
    if (record.error.kind === 'assertion' && judgeFailed) record.error.kind = 'judge'
    record.outcome = record.error.kind === 'infra' ? 'infra_error' : 'fail'
    if (timedOut()) throw new Error(`Eval timed out after ${spec.timeoutMs / 1000}s`)
    throw error
  } finally {
    clock?.clear()
    if (sandbox) report({ kind: 'cleanup' })
    testSignal.removeEventListener('abort', destroy)
    await session?.close().catch(() => {})
    await sandbox?.destroy()
    const recordPath = join(
      stagingDir,
      'evals',
      recordFileName(attemptKey(id, spec.cell.key, spec.n)),
    )
    await mkdir(join(stagingDir, 'evals'), { recursive: true })
    await writeFile(recordPath, redactSecrets(JSON.stringify(record, null, 2)))
    const meta: EvalMeta = {
      outcome: record.outcome,
      errorKind: record.error?.kind ?? null,
      judgements: record.judgements.map((j) => ({
        verdict: j.verdict,
        score: j.score,
        threshold: j.threshold,
        question: clip(j.question, 200),
      })),
    }
    setMeta(meta)
  }
}
