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
import { type ResolvedEnvironment, resolveEnvironment } from './environment/resolve.ts'
import { createHarness } from './harness/index.ts'
import type { HarnessSession } from './harness/types.ts'
import { attemptId, attemptKey, evalId, recordFileName, relativeFile } from './ids.ts'
import { type JudgeState, judgeModelName, runJudge } from './judge/index.ts'
import { changedFilesForJudge, patchForJudge } from './judge/patch.ts'
import {
  cascade,
  checkOptions,
  expand,
  type Level,
  matchesTags,
  type PlannedAttempt,
  type Resolved,
} from './options.ts'
import { redactSecrets } from './redact.ts'
import { createSandbox, InfraError, type Sandbox } from './sandbox/index.ts'
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
  JudgeOptions,
  ResolvedConfig,
  Turn,
} from './types.ts'

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
  if (typeof a === 'function') return [(b as EvalOptions | undefined) ?? {}, a]
  if (typeof b === 'function') return [(a as EvalOptions | undefined) ?? {}, b]
  throw new TypeError(`${what}("${name}") needs a function`)
}

type GroupFn = {
  (name: string, fn: () => void, options?: GroupOptions): void
  (name: string, options: GroupOptions, fn: () => void): void
}

const defineGroup =
  (mode: TestMode): GroupFn =>
  (name: string, a?: GroupOptions | (() => void), b?: GroupOptions | (() => void)) => {
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
    runs: config.runs,
    env: config.env,
    judge: config.judge,
    timeout: undefined,
    tags: [],
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
  const resolved = cascade(configLevel(ctx.config), levels, where, ctx.runs)
  if (!matchesTags(resolved.tags, ctx.tags)) return
  const timeoutMs =
    resolved.timeout === undefined ? ctx.config.timeoutMs : parseDuration(resolved.timeout)
  for (const planned of expand(resolved)) {
    const baked = planned.environment.steps.filter((s) => s.kind === 'exec' && s.cache).length
    const setup =
      planned.sandbox.kind === 'docker' && (planned.sandbox.from || baked > 0) ? SETUP_BUDGET_MS : 0
    const attempt: AttemptMeta = {
      name,
      groups,
      tags: resolved.tags,
      cell: planned.cell,
      n: planned.n,
      label: planned.label,
      harness: planned.harness,
    }
    const spec: AttemptSpec = {
      ...planned,
      name,
      groups,
      timeoutMs,
      env: resolved.env,
      judge: resolved.judge,
    }
    registerTest(
      `${name} [${attemptId(planned.cell.key, planned.n)}]`,
      { timeout: timeoutMs + setup + GRACE_MS, mode, attempt },
      (handle) => runAttempt(spec, fn, handle),
    )
  }
}

const defineEval =
  (mode: TestMode): EvaluateFn =>
  (name: string, a?: EvalOptions | EvalFn, b?: EvalOptions | EvalFn) => {
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
    return /timed out/i.test(reason)
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

async function runAttempt(
  spec: AttemptSpec,
  fn: EvalFn,
  { file, signal: testSignal, setMeta, attachRecord }: TestHandle,
): Promise<void> {
  const { runId, resultsDir, config } = getRunContext()
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
      record.image = await prepareImage(spec.sandbox, resolved.baked, testSignal)
      image = record.image.ref
    }
  }

  const requireSandbox = () => {
    if (!sandbox) throw new Error('No sandbox yet: call t.send() before t.exec() or t.readFile()')
    return sandbox
  }
  const exec = async (command: string) => {
    const start = performance.now()
    const r = await timed('checksMs', () => requireSandbox().exec(command, { signal }))
    record.checks.push({ command, ...r, durationMs: Math.round(performance.now() - start) })
    return r
  }
  const readFile = (path: string) => requireSandbox().readFile(path)

  async function startSession(): Promise<[Sandbox, HarnessSession]> {
    const env = resolved as ResolvedEnvironment
    const box = await createSandbox(spec.sandbox, {
      runId,
      timeoutMs: spec.timeoutMs + 60_000,
      signal,
      env: env.vars,
      image,
    })
    sandbox = box
    if (signal.aborted) destroy()
    signal.throwIfAborted()
    for (const f of env.files) await box.writeFile(f.path, f.content)
    // The fake sandbox has no image to bake into, so it runs every step here.
    const steps =
      spec.sandbox.kind === 'docker' ? env.perAttempt : [...env.baked, ...env.perAttempt]
    for (const command of steps) {
      const r = await box.exec(command, { signal })
      if (r.exitCode !== 0) {
        throw new InfraError(
          `Setup step "${command}" for environment ${spec.environment.name} exited ${r.exitCode}:\n${tailOf(r.stderr || r.stdout)}`,
        )
      }
    }
    await snapshot(box, signal)
    if (spec.sandbox.kind === 'docker') record.context = await agentContext(box, signal)
    const harness = await createHarness(spec.harness)
    session = await harness.start(box, signal, { skills: env.skills, mcp: env.mcp })
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
      const [box, agent] =
        sandbox && session ? [sandbox, session] : await timed('setupMs', startSession)
      const entry = {
        prompt,
        text: '',
        status: 'error' as const,
        transcript: [],
        startedAt: new Date().toISOString(),
        durationMs: 0,
      }
      record.turns.push(entry)
      const { raw, ...result } = await timed('agentMs', () => agent.send(prompt, signal))
      Object.assign(entry, result, raw ? { raw } : {})
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
      record.judgeInputs?.push({ question, model: judgeModelName(model), state })
      try {
        const verdict = await timed('judgeMs', () =>
          runJudge(
            question,
            state,
            { ...options, model, threshold: options.threshold ?? 0.8 },
            signal,
          ),
        )
        record.judgements.push(verdict)
        return verdict
      } catch (error) {
        judgeErrored = true
        throw error
      }
    },
  }

  const timedOut = () => !!timer?.aborted && !testSignal.aborted
  try {
    await timed('setupMs', setup)
    timer = AbortSignal.timeout(spec.timeoutMs)
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
    testSignal.removeEventListener('abort', destroy)
    await session?.close().catch(() => {})
    await sandbox?.destroy()
    const recordPath = join(
      resultsDir,
      'evals',
      recordFileName(attemptKey(id, spec.cell.key, spec.n)),
    )
    await mkdir(join(resultsDir, 'evals'), { recursive: true })
    await writeFile(recordPath, redactSecrets(JSON.stringify(record, null, 2)))
    const meta: EvalMeta = {
      outcome: record.outcome,
      errorKind: record.error?.kind ?? null,
      judgements: record.judgements.map((j) => ({
        verdict: j.verdict,
        score: j.score,
        threshold: j.threshold,
        question: j.question.slice(0, 200),
      })),
      recordPath,
    }
    setMeta(meta)
    await attachRecord(recordPath).catch(() => {})
  }
}
