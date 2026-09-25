import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineEval, EngineRun } from '../engine/node.ts'
import { NO_ENVIRONMENT } from '../environment.ts'
import { isTimeout } from '../errors.ts'
import { attemptId, evalSlug, recordFileName, sha256 } from '../ids.ts'
import { judgeModelName } from '../judge/index.ts'
import { collapseDependencies, patchForJudge } from '../judge/patch.ts'
import { harnessId, sandboxId } from '../options.ts'
import type { RunPlan } from '../plan.ts'
import type { SandboxVersions } from '../preflight.ts'
import { redactSecrets } from '../redact.ts'
import type {
  Cell,
  EnvironmentRecord,
  EvalRecord,
  FileChange,
  HarnessDescriptor,
  Outcome,
  RunContext,
} from '../types.ts'
import { FINGERPRINT_SCOPE, judgeVersion, packageVersions, WORKTREE_PATCH_LIMIT } from './state.ts'
import {
  type AttemptFiles,
  type AttemptRecord,
  type CellRecord,
  type ContextFile,
  type EvalEntry,
  type FileRef,
  type GitInfo,
  type JudgementRecord,
  type Lift,
  type RunnerInfo,
  type RunRecord,
  SCHEMA_VERSION,
  type Stack,
} from './types.ts'

/** Final messages are kept whole in the record unless they're this big. */
const TURN_TEXT_LIMIT = 64 * 1024
/** A single tool output, check stream or file diff bigger than this keeps its head and tail. */
export const OUTPUT_CAP = 128 * 1024
const HEAD = 96 * 1024
const TAIL = 16 * 1024

export type AssembleInput = {
  ctx: RunContext
  engine: EngineRun
  startedAt: Date
  endedAt: Date
  interrupted: boolean
  /** `budget.duration` stopped new attempts from starting. */
  budgetReached: boolean
  plan: RunPlan
  author: string
  es: string
  /** Name and version of the embedded test engine. */
  enginePackages: Record<string, string>
  sandbox: SandboxVersions
  git: GitInfo | null
  /** Uncommitted changes when the run started, saved as `worktree.patch`. */
  worktreePatch: Buffer | null
  lockfiles: RunRecord['dependencies']['lockfiles']
  runner: RunnerInfo
}

export type AssembledRun = {
  record: RunRecord
  /** Artifact files keyed by path inside the run's artifact directory. */
  artifacts: Map<string, Uint8Array>
}

/** Keeps evidence readable without letting one `cat` of a lockfile dominate the record. */
export function capText(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text
  const omitted = text.length - HEAD - TAIL
  return `${text.slice(0, HEAD)}\n[es: truncated ${omitted} of ${text.length} characters, sha256 ${sha256(text)}]\n${text.slice(-TAIL)}`
}

const readRecord = async (path: string): Promise<EvalRecord | null> =>
  JSON.parse(await readFile(path, 'utf8').catch(() => 'null'))

type Merged = Pick<EvalRecord, 'error'> & { outcome: Outcome }

/** The engine and the worker's record can disagree, e.g. when a timeout fails the eval first. */
function mergeOutcome(e: EngineEval, record: EvalRecord | null): Merged {
  if (e.state === 'skipped' && record && record.outcome !== 'pass') {
    return { outcome: record.outcome, error: record.error }
  }
  if (e.state === 'skipped') return { outcome: 'skipped', error: null }
  if (e.state === 'passed') return { outcome: 'pass', error: null }
  const message = e.errors[0] ?? 'Eval failed'
  const error = isTimeout(message)
    ? { kind: 'timeout' as const, message: record?.error?.message ?? message }
    : (record?.error ?? { kind: 'assertion' as const, message })
  return { outcome: record?.outcome === 'infra_error' ? 'infra_error' : 'fail', error }
}

/** Any failure fails; then infra errors; then all-skipped; else pass. */
export function worstOutcome(outcomes: Outcome[]): Outcome {
  if (outcomes.includes('fail')) return 'fail'
  if (outcomes.includes('infra_error')) return 'infra_error'
  if (outcomes.length > 0 && outcomes.every((o) => o === 'skipped')) return 'skipped'
  return outcomes.length ? 'pass' : 'skipped'
}

const passRateOf = (outcomes: Outcome[]) => {
  const pass = outcomes.filter((o) => o === 'pass').length
  const counted = pass + outcomes.filter((o) => o === 'fail').length
  return counted ? pass / counted : null
}

/** Concurrency caps change how fast a run goes, not what it measures. */
const withoutCaps = <T extends { maxConcurrent?: number }>({ maxConcurrent: _, ...rest }: T) => rest

const harnessModel = (h: HarnessDescriptor) => (h.kind === 'cursor' ? (h.model ?? null) : null)

/** Collects artifact files, redacting before anything is hashed. */
class Artifacts {
  readonly files = new Map<string, Uint8Array>()

  add(path: string, content: string): FileRef {
    const bytes = Buffer.from(redactSecrets(content))
    this.files.set(path, bytes)
    return { path, sha256: sha256(bytes), bytes: bytes.length }
  }

  json(path: string, value: unknown): FileRef {
    return this.add(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

const endOf = (startedAt: string, durationMs: number) =>
  new Date(Date.parse(startedAt) + durationMs).toISOString()

/** One JSON object per line: each turn's prompt, its events, then a `turn-end`. */
function transcriptLines(record: EvalRecord): string {
  const lines: string[] = []
  record.turns.forEach((turn, index) => {
    lines.push(
      JSON.stringify({
        ts: turn.startedAt,
        atMs: 0,
        turn: index,
        type: 'prompt',
        text: turn.prompt,
      }),
    )
    for (const event of turn.transcript) {
      if (event.type === 'tool') {
        const raw =
          typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2)
        if (raw !== undefined && raw.length > OUTPUT_CAP) {
          lines.push(JSON.stringify({ turn: index, ...event, output: capText(raw) }))
          continue
        }
      }
      lines.push(JSON.stringify({ turn: index, ...event }))
    }
    lines.push(
      JSON.stringify({
        ts: endOf(turn.startedAt, turn.durationMs),
        atMs: turn.durationMs,
        turn: index,
        type: 'turn-end',
        status: turn.status,
        durationMs: turn.durationMs,
      }),
    )
  })
  return `${lines.join('\n')}\n`
}

/** Every stream part the harness sent, for debugging the normaliser (`ES_RAW_TRANSCRIPT=1`). */
function rawLines(record: EvalRecord): string | null {
  if (!record.turns.some((t) => t.raw)) return null
  const lines = record.turns.flatMap((turn, index) =>
    (turn.raw ?? []).map((part) => JSON.stringify({ turn: index, ...(part as object) })),
  )
  return `${lines.join('\n')}\n`
}

function activity(record: EvalRecord): AttemptRecord['activity'] {
  const events = record.turns.flatMap((t) => t.transcript)
  const count = (type: string) => events.filter((e) => e.type === type).length
  const reasoningMs = events.reduce(
    (n, e) => n + (e.type === 'reasoning' ? (e.durationMs ?? 0) : 0),
    0,
  )
  return {
    tools: count('tool'),
    fileEdits: count('file-edit'),
    webSearches: count('web-search'),
    webFetches: count('web-fetch'),
    reasoningMs,
  }
}

const block = (label: string, text: string) => {
  const body = capText(text)
  return `--- ${label}\n${body}${body.endsWith('\n') || !body ? '' : '\n'}`
}

const checkLog = (c: EvalRecord['checks'][number]) =>
  `$ ${c.command}\nexit ${c.exitCode}\n${block('stdout', c.stdout)}${block('stderr', c.stderr)}`

/** Dependency and binary noise dropped, and each remaining file's diff capped. */
function historyPatch(patch: string): string {
  return patchForJudge(patch)
    .split(/(?=^diff --git )/m)
    .map((part) => capText(part))
    .join('')
}

function changedFiles(files: FileChange[]): AttemptRecord['changedFiles'] {
  const { kept, dirs } = collapseDependencies(files, (f) => f.path)
  return [...kept, ...dirs.map((d) => ({ path: d.dir, status: 'added' as const, count: d.count }))]
}

/** Judge inputs whose diff is the recorded diff point at `diff.patch` instead of repeating it. */
function judgeInputs(record: EvalRecord, diff: string | null, diffPath: string) {
  return (record.judgeInputs ?? []).map((input) => {
    if (diff === null || input.state.diff !== diff) return input
    return { ...input, state: { ...input.state, diff: { $ref: diffPath, sha256: sha256(diff) } } }
  })
}

async function sourceHash(root: string, file: string): Promise<string | null> {
  const bytes = await readFile(join(root, file)).catch(() => null)
  return bytes ? sha256(bytes) : null
}

/** What the run's attempts have in common, gathered while their records are read. */
class Seen {
  readonly sources = new Map<string, string | null>()
  readonly byEval = new Map<string, EvalEntry>()
  readonly contexts = new Map<string, ContextFile>()
  readonly resolvedJudges = new Set<string>()
  readonly images = new Map<string, Stack['images'][number]>()
  readonly environments = new Map<string, EnvironmentRecord>()
  readonly harnesses = new Map<string, Stack['harnesses'][number]>()
  /** Registry digests found by the preflight, by image id. */
  readonly digests: Map<string, string[]>

  constructor(sandbox: SandboxVersions) {
    this.digests = new Map(sandbox.images.map((i) => [i.id, i.repoDigests]))
  }

  add(record: EvalRecord | null, cell: Cell, e: EngineEval): void {
    for (const c of record?.context ?? []) this.contexts.set(`${c.path}\0${c.sha256}`, c)
    for (const j of record?.judgements ?? []) {
      if (j.resolvedModel) this.resolvedJudges.add(j.resolvedModel)
    }
    if (record?.image) {
      const repoDigests = this.digests.get(record.image.id) ?? []
      this.images.set(record.image.id, { ...record.image, repoDigests })
    }
    if (record?.environment && record.environment.name !== NO_ENVIRONMENT) {
      const key = `${record.environment.name}\0${record.environment.digest}`
      this.environments.set(key, record.environment)
    }
    if (e.attempt) {
      const h = e.attempt.harness
      this.harnesses.set(cell.harness, { id: cell.harness, kind: h.kind, model: harnessModel(h) })
    }
  }

  entry(e: EngineEval, sourceHash: string | null): EvalEntry {
    let entry = this.byEval.get(e.id)
    if (!entry) {
      entry = {
        id: e.id,
        slug: evalSlug(e.id),
        file: e.file,
        group: e.group,
        name: e.name,
        tags: e.attempt?.tags ?? [],
        fingerprint: '',
        sourceHash,
        fixtureHash: null,
        outcome: 'skipped',
        passRate: null,
        cells: [],
        attempts: [],
      }
      this.byEval.set(e.id, entry)
    }
    return entry
  }
}

const UNKNOWN_CELL: Cell = {
  key: 'unknown',
  harness: 'unknown',
  environment: 'unknown',
  sandbox: 'unknown',
  role: 'control',
}

/** minLift per cell, kept aside while attempts are added; see `rollUp`. */
const minLifts = new WeakMap<CellRecord, number>()

function cellOf(entry: EvalEntry, cell: Cell, gated: boolean): CellRecord {
  let found = entry.cells.find((c) => c.key === cell.key)
  if (!found) {
    found = {
      ...cell,
      fingerprint: '',
      gated,
      overrides: [],
      runs: 0,
      pass: 0,
      fail: 0,
      infraError: 0,
      skipped: 0,
      passRate: null,
      outcome: 'skipped',
    }
    entry.cells.push(found)
  }
  return found
}

type JudgeFingerprint = { model: string | null; threshold: number }

/** Reads one attempt's worker record, files its artifacts and adds it to its eval and cell. */
async function addAttempt(
  e: EngineEval,
  ctx: RunContext,
  seen: Seen,
  out: Artifacts,
  judge: JudgeFingerprint,
): Promise<void> {
  const cell = e.attempt?.cell ?? UNKNOWN_CELL
  const n = e.attempt?.n ?? 1
  const record = await readRecord(join(ctx.stagingDir, 'evals', recordFileName(e.key)))
  const { outcome, error } = mergeOutcome(e, record)
  if (!seen.sources.has(e.file)) {
    seen.sources.set(e.file, await sourceHash(ctx.config.root, e.file))
  }
  const srcHash = seen.sources.get(e.file) ?? null
  const context = record?.context ?? []
  seen.add(record, cell, e)
  const entry = seen.entry(e, srcHash)
  const cellRecord = cellOf(entry, cell, e.attempt?.gated ?? true)
  if (e.attempt?.minLift !== undefined) minLifts.set(cellRecord, e.attempt.minLift)
  if (record?.environment?.overrides.length && cellRecord.overrides.length === 0) {
    cellRecord.overrides = [...record.environment.overrides]
  }
  // Skipped attempts never ran, so they have no environment or image to fingerprint.
  if (!cellRecord.fingerprint || record) {
    cellRecord.fingerprint = sha256(
      JSON.stringify({
        sourceHash: srcHash,
        harness: e.attempt?.harness ?? null,
        environment: record?.environment?.digest ?? cell.environment,
        image: record?.image?.id ?? null,
        agentCli: record?.image?.agentCli ?? null,
        judge,
        context,
      }),
    )
  }
  entry.attempts.push({
    id: attemptId(cell.key, n),
    cell: cell.key,
    n,
    image: record?.image ?? null,
    env: record?.env ?? { vars: [], secrets: [] },
    context,
    outcome,
    error,
    durationMs: e.durationMs,
    ...attemptEvidence(record, `${entry.slug}/${evalSlug(cell.key)}/${n}`, out),
  })
}

/** Turns, timings, activity, verdicts, checks and changed files, with their artifact files. */
function attemptEvidence(
  record: EvalRecord | null,
  dir: string,
  out: Artifacts,
): Pick<
  AttemptRecord,
  'turns' | 'timings' | 'activity' | 'judgements' | 'checks' | 'changedFiles' | 'files'
> {
  const files: AttemptFiles = {}
  if (record?.setup?.length) {
    const log = record.setup
      .map(
        (s) =>
          `$ ${s.run}\n${s.exitCode === null ? 'timed out' : `exit ${s.exitCode}`} after ${s.durationMs}ms\n${capText(s.output)}${s.output.endsWith('\n') || !s.output ? '' : '\n'}`,
      )
      .join('\n')
    files.setupLog = out.add(`${dir}/setup.log`, log)
  }
  if (record && record.turns.length > 0) {
    files.transcript = out.add(`${dir}/transcript.jsonl`, transcriptLines(record))
    const raw = rawLines(record)
    if (raw) files.rawTranscript = out.add(`${dir}/transcript.raw.jsonl`, raw)
  }
  const patch = record?.diff ? historyPatch(record.diff.patch) : null
  if (patch !== null) files.diff = out.add(`${dir}/diff.patch`, patch)
  if (record?.judgeInputs?.length) {
    files.judgeInput = out.json(`${dir}/judge-input.json`, judgeInputs(record, patch, 'diff.patch'))
  }
  const judgements: JudgementRecord[] = (record?.judgements ?? []).map((j) => ({
    ...j,
    reason: null,
    evidence: [],
  }))
  return {
    turns: (record?.turns ?? []).map((t) => ({
      prompt: t.prompt,
      status: t.status,
      startedAt: t.startedAt,
      durationMs: t.durationMs,
      text:
        t.text.length > TURN_TEXT_LIMIT
          ? `${t.text.slice(0, TURN_TEXT_LIMIT)}… [es: truncated ${t.text.length} characters; the whole message is the turn's last text event in transcript.jsonl]`
          : t.text,
    })),
    timings: record?.timings ?? { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
    activity: record
      ? activity(record)
      : { tools: 0, fileEdits: 0, webSearches: 0, webFetches: 0, reasoningMs: 0 },
    judgements,
    checks: (record?.checks ?? []).map((c, i) => ({
      command: c.command,
      exitCode: c.exitCode,
      durationMs: c.durationMs,
      log: out.add(`${dir}/checks/${i + 1}.log`, checkLog(c)),
    })),
    changedFiles: changedFiles(record?.diff?.files ?? []),
    files,
  }
}

/** Lift of each variant cell over the control on the same harness and sandbox. */
function liftOf(control: CellRecord, variant: CellRecord): Lift | undefined {
  if (control.passRate === null || variant.passRate === null) return undefined
  const minLift = minLifts.get(variant)
  return {
    vs: control.key,
    points: Math.round((variant.passRate - control.passRate) * 1000) / 1000,
    controlPassRate: control.passRate,
    variantPassRate: variant.passRate,
    n: Math.min(control.pass + control.fail, variant.pass + variant.fail),
    ...(minLift !== undefined ? { minLift } : {}),
  }
}

/** Per-cell and per-eval counts, pass rates, lift, outcomes and fingerprints, once every attempt is in. */
function rollUp(evals: EvalEntry[]): void {
  for (const entry of evals) {
    for (const c of entry.cells) {
      const outcomes = entry.attempts.filter((a) => a.cell === c.key).map((a) => a.outcome)
      c.runs = outcomes.length
      c.pass = outcomes.filter((o) => o === 'pass').length
      c.fail = outcomes.filter((o) => o === 'fail').length
      c.infraError = outcomes.filter((o) => o === 'infra_error').length
      c.skipped = outcomes.filter((o) => o === 'skipped').length
      c.passRate = passRateOf(outcomes)
      c.outcome = worstOutcome(outcomes)
    }
    for (const c of entry.cells) {
      if (c.role !== 'variant') continue
      const control = entry.cells.find(
        (x) => x.role === 'control' && x.harness === c.harness && x.sandbox === c.sandbox,
      )
      const lift = control && liftOf(control, c)
      if (!lift) continue
      c.lift = lift
      if (lift.minLift !== undefined && lift.points < lift.minLift && c.outcome === 'pass') {
        c.outcome = 'fail'
      }
    }
    entry.outcome = worstOutcome(
      entry.cells.map((c) => (!c.gated && c.outcome === 'fail' ? 'pass' : c.outcome)),
    )
    entry.passRate = passRateOf(entry.attempts.map((a) => a.outcome))
    entry.fingerprint = sha256(
      JSON.stringify(entry.cells.map((c) => [c.key, c.fingerprint]).sort()),
    )
  }
}

/** The run's git state, with the uncommitted changes kept as `worktree.patch` when they fit. */
function gitState(input: AssembleInput, out: Artifacts): GitInfo | null {
  const git = input.git
  if (!git?.dirty) return git
  const patch = input.worktreePatch
  const state = { ...git, diffHash: patch ? sha256(patch) : null }
  if (!patch) state.worktreePatchNote = 'git could not produce a patch'
  else if (patch.length > WORKTREE_PATCH_LIMIT) {
    state.worktreePatchNote = `too large to keep (${patch.length} bytes)`
  } else {
    // Kept byte-exact so it applies; recording still refuses it if it looks like a secret.
    out.files.set('worktree.patch', patch)
    state.worktreePatch = { path: 'worktree.patch', sha256: sha256(patch), bytes: patch.length }
  }
  return state
}

const byName =
  <T>(key: (x: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0

function stackOf(input: AssembleInput, seen: Seen, judgeModel: string | null): Stack {
  const { config } = input.ctx
  const packages = packageVersions(input.enginePackages)
  return {
    es: input.es,
    node: process.versions.node,
    os: process.platform,
    arch: process.arch,
    images: [...seen.images.values()].sort(byName((i) => i.ref)),
    packages,
    harnesses: [...seen.harnesses.values()].sort(byName((h) => h.id)),
    judge: {
      model: judgeModel,
      resolvedModels: [...seen.resolvedJudges].sort(),
      threshold: config.judge.threshold,
      version: judgeVersion(input.es, packages, judgeModel ?? ''),
    },
    context: [...seen.contexts.values()].sort(byName((c) => c.path)),
    fingerprintScope: FINGERPRINT_SCOPE,
  }
}

export async function assembleRun(input: AssembleInput): Promise<AssembledRun> {
  const { ctx, engine } = input
  const { config, runId } = ctx
  const out = new Artifacts()
  const judgeModel = config.judge.model === undefined ? null : judgeModelName(config.judge.model)
  const configHash = sha256(
    JSON.stringify({
      include: config.include,
      harness: config.harness.map(withoutCaps),
      sandbox: withoutCaps(config.sandbox),
      environment: config.environment ?? null,
      runs: config.runs,
      env: config.env,
      judge: withoutCaps(config.judge),
      timeoutMs: config.timeoutMs,
    }),
  )
  const seen = new Seen(input.sandbox)
  const judge = { model: judgeModel, threshold: config.judge.threshold }
  for (const e of engine.evals) await addAttempt(e, ctx, seen, out, judge)
  const evals = [...seen.byEval.values()]
  rollUp(evals)

  const attempts = evals.flatMap((e) => e.attempts)
  const count = (o: Outcome) => attempts.filter((a) => a.outcome === o).length
  const notGated = evals
    .flatMap((e) =>
      e.attempts.filter((a) => e.cells.find((c) => c.key === a.cell)?.gated === false),
    )
    .filter((a) => a.outcome === 'fail').length
  const { profile } = ctx
  const ids = (list: HarnessDescriptor | HarnessDescriptor[] | undefined) =>
    list === undefined ? undefined : [list].flat().map(harnessId)
  const record: RunRecord = {
    kind: 'es-run',
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: input.interrupted ? 'interrupted' : input.budgetReached ? 'budget' : 'complete',
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    author: input.author,
    git: gitState(input, out),
    runner: input.runner,
    dependencies: { lockfiles: input.lockfiles },
    stack: stackOf(input, seen, judgeModel),
    environments: [...seen.environments.values()].sort(byName((e) => e.name)),
    profile: profile
      ? {
          name: profile.name,
          reason: profile.reason,
          defaults: JSON.parse(
            JSON.stringify({
              harness: ids(profile.defaults.harness),
              environment: profile.defaults.environment?.name,
              sandbox: profile.defaults.sandbox && sandboxId(profile.defaults.sandbox),
              runs: profile.defaults.runs,
              timeout: profile.defaults.timeout,
              env: profile.defaults.env && Object.keys(profile.defaults.env).sort(),
            }),
          ),
          limit: profile.limit,
        }
      : null,
    plan: {
      evals: input.plan.evals,
      cells: input.plan.cells,
      attempts: input.plan.attempts,
      estimateMs: Math.round(input.plan.estimateMs),
    },
    budget: Object.keys(input.plan.budget).length ? input.plan.budget : null,
    config: {
      harnesses: config.harness.map(harnessId),
      sandbox: sandboxId(config.sandbox),
      environment: config.environment?.name ?? null,
      runs: config.runs,
      judgeModel,
      threshold: config.judge.threshold,
      timeoutMs: config.timeoutMs,
      concurrency: input.ctx.concurrency,
      configHash,
    },
    cost: { usd: null, inputTokens: null, outputTokens: null, source: 'unreported' },
    artifacts: 'all',
    redaction: { version: 1 },
    summary: {
      evals: evals.length,
      attempts: attempts.length,
      pass: count('pass'),
      fail: count('fail'),
      notGated,
      infraError: count('infra_error'),
      skipped: count('skipped'),
    },
    evals,
  }
  return { record, artifacts: out.files }
}
