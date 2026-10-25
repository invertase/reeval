import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AskedAttemptAnswer,
  AskedCall,
  AskedQuestion,
  AskedScreenshot,
  SettledQuestions,
} from '../compare/questions.ts'
import { resolveQuestionState } from '../compare/state.ts'
import type { EngineEval, EngineRun } from '../engine/node.ts'
import { NO_ENVIRONMENT, profileSandbox } from '../environment.ts'
import { isTimeout } from '../errors.ts'
import { harnessEffort, resolvedEffortOf, servedEffortOf } from '../harness/effort.ts'
import { attemptId, attemptKey, evalSlug, recordFileName, sha256 } from '../ids.ts'
import { judgeModelName } from '../judge/index.ts'
import { collapseDependencies, patchForJudge } from '../judge/patch.ts'
import { mergeJudge, resolveStateOptions } from '../judge/state-options.ts'
import { harnessId, plannedSandboxes, profileJudge, sandboxId } from '../options.ts'
import type { RunPlan } from '../plan.ts'
import type { SandboxVersions } from '../preflight.ts'
import { redactJsonText, redactSecrets } from '../redact.ts'
import { isCompletedAttempt, previousAttempt } from '../resume.ts'
import { containsZero, liftInterval, round3 } from '../stats.ts'
import { formatDuration } from '../text.ts'
import type {
  AttemptAnswer,
  AttemptQuestionInput,
  Cell,
  CellGate,
  EnvironmentRecord,
  EvalRecord,
  ExecResult,
  FamilyMeta,
  FileChange,
  HarnessDescriptor,
  Outcome,
  QuestionCall,
  QuestionInput,
  QuestionScreenshot,
  ResolvedGateway,
  ResolvedJudgeStateOptions,
  RunContext,
  TranscriptEvent,
  WebEventType,
} from '../types.ts'
import { promptTokens, sumUsage } from '../usage.ts'
import { checkVerdict } from '../view/contrasts.ts'
import { checkTries } from '../view/judgements.ts'
import { familiesOf } from './families.ts'
import { type Source, traceSources } from './sources.ts'
import { FINGERPRINT_SCOPE, judgeVersion, packageVersions, WORKTREE_PATCH_LIMIT } from './state.ts'
import {
  type AttemptFiles,
  type AttemptRecord,
  type CellRecord,
  type ContextFile,
  type Cost,
  type EvalEntry,
  type FileRef,
  type FingerprintParts,
  type GitInfo,
  type JudgementRecord,
  type Lift,
  type RunnerInfo,
  type RunRecord,
  SCHEMA_VERSION,
  type Stack,
} from './types.ts'

/** Final messages are cut at this size in the record; `transcript.jsonl` keeps them whole. */
const TURN_TEXT_LIMIT = 8 * 1024
const TURN_ERROR_LIMIT = 1024

/** A turn's first error event, such as the provider's "Credit balance is too low". */
function turnError(transcript: TranscriptEvent[] | undefined): string | null {
  const found = transcript?.find((e) => e.type === 'error')
  if (found?.type !== 'error') return null
  const message = found.message.trim()
  return message.length > TURN_ERROR_LIMIT ? `${message.slice(0, TURN_ERROR_LIMIT)}…` : message
}

/** Tokens across every turn that reported them. */
function costOf(attempts: AttemptRecord[]): Cost {
  const usage = sumUsage(attempts.map((a) => a.usage))
  if (!usage) {
    return { inputTokens: null, outputTokens: null, usage: null, source: 'unreported' }
  }
  return {
    inputTokens: promptTokens(usage),
    outputTokens: usage.output,
    usage,
    source: 'reported',
  }
}

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
  /** A resumed interrupted/budget record, so completed attempts keep their evidence. */
  previous?: RunRecord | null
  /** Artifact directory of `previous`, when it was moved aside into staging. */
  previousArtifacts?: string | null
  reeval: string
  runtime: NonNullable<Stack['runtime']>
  /** What the evals are written in; a runner for another language gives its own. */
  language: NonNullable<Stack['language']>
  /** Name and version of the embedded test engine. */
  enginePackages: Record<string, string>
  sandbox: SandboxVersions
  git: GitInfo | null
  /** Uncommitted changes when the run started, saved as `worktree.patch`. */
  worktreePatch: Buffer | null
  lockfiles: RunRecord['dependencies']['lockfiles']
  runner: RunnerInfo
  /** Each eval's pairwise answers by eval id, and each attempt's own answers by its key. */
  answers?: SettledQuestions
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
  return `${text.slice(0, HEAD)}\n[reeval: truncated ${omitted} of ${text.length} characters, sha256 ${sha256(text)}]\n${text.slice(-TAIL)}`
}

const readRecord = async (path: string): Promise<EvalRecord | null> =>
  JSON.parse(await readFile(path, 'utf8').catch(() => 'null'))

type Merged = Pick<EvalRecord, 'error'> & { outcome: Outcome }

/** The engine and the worker's record can disagree, e.g. when a timeout fails the eval first. */
export function mergeOutcome(e: EngineEval, record: EvalRecord | null): Merged {
  // A resume skips a completed attempt: keep the staged (or previous) outcome, including pass.
  if (e.state === 'skipped' && record) return { outcome: record.outcome, error: record.error }
  if (e.state === 'skipped') return { outcome: 'skipped', error: null }
  if (e.state === 'passed') return { outcome: 'pass', error: null }
  const message = e.errors[0] ?? 'Eval failed'
  // The worker's own classification wins: a setup InfraError whose message says "timed out"
  // isn't the eval's timeout. Without a record, the engine's error name is all there is.
  const error =
    record?.error ??
    (isTimeout({ name: e.errorName })
      ? { kind: 'timeout' as const, message }
      : { kind: 'assertion' as const, message })
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

/**
 * The harness as the measurement sees it: without the operational limits (`maxConcurrent`,
 * `startTimeout`), which don't change results, and without the route, which `gateway` holds.
 */
const withoutCaps = <
  T extends { maxConcurrent?: number; startTimeout?: unknown; gateway?: unknown },
>({
  maxConcurrent: _,
  startTimeout: __,
  gateway: ___,
  ...rest
}: T) => rest

const harnessModel = (h: HarnessDescriptor) => (h.kind === 'fake' ? null : (h.model ?? null))

/** A cell fingerprint: the hash of its parts, so each part can be compared on its own. */
export const fingerprintOf = (parts: FingerprintParts) => sha256(JSON.stringify(parts))

/** The gateway's part of a fingerprint: none on `direct`, so a cell without a gateway keeps its fingerprint. */
export const gatewayPart = (
  gateway: ResolvedGateway | undefined,
): Pick<FingerprintParts, 'gateway'> =>
  gateway && gateway.name !== 'direct' ? { gateway: gateway.name } : {}

/** `<index>:<question hash>`, which follows one verdict across runs. */
export const judgementKey = (index: number, question: string) =>
  `${index}:${sha256(question).slice(0, 12)}`

const JSON_FILE = /\.(?:json|jsonl|ndjson)$/

/** Collects artifact files, redacting before anything is hashed. */
class Artifacts {
  readonly files = new Map<string, Uint8Array>()

  /** JSON and JSON Lines files are masked inside their strings only, so they stay valid. */
  add(path: string, content: string): FileRef {
    const bytes = Buffer.from(
      JSON_FILE.test(path) ? redactJsonText(content) : redactSecrets(content),
    )
    this.files.set(path, bytes)
    return { path, sha256: sha256(bytes), bytes: bytes.length }
  }

  /** Binary artifacts (PNGs). Must not run `redactSecrets` — it would corrupt the bytes. */
  addBinary(path: string, content: Uint8Array): FileRef {
    const bytes = Buffer.from(content)
    this.files.set(path, bytes)
    return { path, sha256: sha256(bytes), bytes: bytes.length }
  }

  json(path: string, value: unknown): FileRef {
    return this.add(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

/** A screenshot with its attempt's id resolved to the capture's path in the record. */
function screenshotRef(s: AskedScreenshot, byId: Map<string, AttemptRecord>): QuestionScreenshot {
  if ('missing' in s) return s
  const { attempt, ...shot } = s
  const ref = byId.get(attempt)?.files.artifacts?.find((a) => a.name === s.name)
  return ref ? { ...shot, path: ref.path } : shot
}

/** The answer, with what its model was sent saved as `questions/<n>.json` beside the eval's attempts. */
function withInput(e: EvalEntry, { n, answer, calls }: AskedQuestion, out: Artifacts) {
  if (!calls.length) return answer
  const byId = new Map(e.attempts.map((a) => [a.id, a]))
  const call = ({ screenshots, ...rest }: AskedCall): QuestionCall => ({
    ...rest,
    ...(screenshots ? { screenshots: screenshots.map((s) => screenshotRef(s, byId)) } : {}),
  })
  const doc: QuestionInput = {
    question: answer.question,
    model: answer.model,
    stateOptions: answer.stateOptions ?? resolveQuestionState(undefined, true),
    ...(answer.artifacts !== undefined ? { artifacts: answer.artifacts } : {}),
    calls: calls.map(call),
  }
  return { ...answer, input: out.json(`${e.slug}/questions/${n}.json`, doc) }
}

/** An attempt's own answer, with what its model was sent saved as `questions/<n>.json` in its directory. */
function withAttemptInput(
  e: EvalEntry,
  a: AttemptRecord,
  { n, answer, call }: AskedAttemptAnswer,
  out: Artifacts,
): AttemptAnswer {
  if (!call) return answer
  const { screenshots, ...rest } = call
  const byId = new Map([[a.id, a]])
  const doc: AttemptQuestionInput = {
    question: answer.question,
    model: answer.model,
    stateOptions: answer.stateOptions,
    ...(answer.artifacts !== undefined ? { artifacts: answer.artifacts } : {}),
    ...(answer.choices ? { choices: answer.choices } : {}),
    ...rest,
    ...(screenshots ? { screenshots: screenshots.map((s) => screenshotRef(s, byId)) } : {}),
  }
  const dir = `${e.slug}/${evalSlug(a.cell)}/${a.n}`
  return { ...answer, input: out.json(`${dir}/questions/${n}.json`, doc) }
}

const endOf = (startedAt: string, durationMs: number) =>
  new Date(Date.parse(startedAt) + durationMs).toISOString()

/** One JSON object per line: each turn's prompt, its events, then a `turn-end`. */
export function transcriptLines(record: EvalRecord): string {
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

/** Every stream part the harness sent, for debugging the normaliser (`REEVAL_RAW_TRANSCRIPT=1`). */
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
  const web = (type: WebEventType) => {
    const n = count(type)
    return n === 0 && record.turns.some((t) => t.unreported?.includes(type)) ? null : n
  }
  const reasoningMs = events.reduce(
    (n, e) => n + (e.type === 'reasoning' ? (e.durationMs ?? 0) : 0),
    0,
  )
  const toolDurations = events.flatMap((e) =>
    'durationMs' in e && typeof e.durationMs === 'number' ? [e.durationMs] : [],
  )
  const stalledTools = events.filter((e) => 'stalled' in e && e.stalled).length
  return {
    tools: count('tool'),
    fileEdits: count('file-edit'),
    webSearches: web('web-search'),
    webFetches: web('web-fetch'),
    reasoningMs,
    stalledTools,
    maxToolMs: toolDurations.length ? Math.max(...toolDurations) : null,
  }
}

const block = (label: string, text: string) => {
  const body = capText(text)
  return `--- ${label}\n${body}${body.endsWith('\n') || !body ? '' : '\n'}`
}

const output = (r: ExecResult) => `${block('stdout', r.stdout)}${block('stderr', r.stderr)}`

/** The command, its exit and output; with `retries`, each try's exit and output in turn. */
function checkLog(c: EvalRecord['checks'][number]): string {
  const head = `$ ${c.command}\nexit ${c.exitCode}`
  if (!c.retries || !c.tries?.length) return `${head}\n${output(c)}`
  const of = c.retries + 1
  const tries = c.tries.map(
    (t, i) =>
      `\ntry ${i + 1} of ${of}: exit ${t.exitCode} after ${formatDuration(t.durationMs)}\n${output(t)}`,
  )
  return `${head}, ${checkTries(c) ?? `passed on try 1 of ${of}`}\n${tries.join('')}`
}

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

/** What the run's attempts have in common, gathered while their records are read. */
class Seen {
  readonly sources = new Map<string, Source[]>()
  readonly byEval = new Map<string, EvalEntry>()
  readonly contexts = new Map<string, ContextFile>()
  readonly resolvedJudges = new Set<string>()
  readonly images = new Map<string, Stack['images'][number]>()
  readonly environments = new Map<string, EnvironmentRecord>()
  readonly harnesses = new Map<
    string,
    Omit<Stack['harnesses'][number], 'resolvedModels' | 'resolvedEffort'>
  >()
  readonly resolvedHarnesses = new Map<string, Set<string>>()
  /** Keys of the attempts kept from the previous record on resume. */
  readonly kept = new Set<string>()
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
      this.harnesses.set(cell.harness, {
        id: cell.harness,
        kind: h.kind,
        model: harnessModel(h),
        effort: harnessEffort(h) ?? null,
      })
    }
    const resolved = this.resolvedHarnesses.get(cell.harness) ?? new Set<string>()
    for (const t of record?.turns ?? []) if (t.model) resolved.add(t.model)
    this.resolvedHarnesses.set(cell.harness, resolved)
  }

  /**
   * A kept attempt has no worker record left, so what `add` reads from one comes from the
   * previous record instead: its image, environment, context files and resolved models.
   */
  addKept(
    previous: RunRecord,
    kept: AttemptRecord,
    cell: Cell,
    environmentDigest: string | null,
    planned: boolean,
  ): void {
    this.kept.add(kept.key)
    for (const c of kept.context) this.contexts.set(`${c.path}\0${c.sha256}`, c)
    for (const j of kept.judgements) {
      if (j.resolvedModel) this.resolvedJudges.add(j.resolvedModel)
    }
    const image = previous.stack.images.find((i) => i.id === kept.imageId)
    if (image && !this.images.has(image.id)) this.images.set(image.id, image)
    const environment = previous.environments.find((x) => x.digest === environmentDigest)
    if (environment) {
      this.environments.set(`${environment.name}\0${environment.digest}`, environment)
    }
    const harness = previous.stack.harnesses.find((h) => h.id === cell.harness)
    if (!planned && harness && !this.harnesses.has(cell.harness)) {
      const { resolvedModels: _, resolvedEffort: __, ...rest } = harness
      this.harnesses.set(cell.harness, rest)
    }
    const resolved = this.resolvedHarnesses.get(cell.harness) ?? new Set<string>()
    for (const t of kept.turns) if (t.model) resolved.add(t.model)
    this.resolvedHarnesses.set(cell.harness, resolved)
  }

  entry(e: EngineEval, sources: Source[]): EvalEntry {
    let entry = this.byEval.get(e.id)
    if (!entry) {
      const key = e.id
      entry = {
        id: e.id,
        key,
        slug: evalSlug(key),
        file: e.file,
        group: e.group,
        name: e.name,
        tags: e.attempt?.tags ?? [],
        ...(e.attempt?.plan.compare ? { compare: e.attempt.plan.compare } : {}),
        ...(e.attempt?.family ? { family: familyOf(e.attempt.family) } : {}),
        fingerprint: '',
        sources,
        outcome: 'skipped',
        todo: e.todo === true,
        passRate: null,
        cells: [],
        attempts: [],
      }
      this.byEval.set(e.id, entry)
    }
    return entry
  }
}

const familyOf = ({ id, name, case: index, cases }: FamilyMeta): EvalEntry['family'] => ({
  id,
  name,
  case: index,
  cases,
})

const UNKNOWN_CELL: Cell = {
  key: 'unknown',
  harness: 'unknown',
  environment: 'unknown',
  sandbox: 'unknown',
  role: 'control',
}

/** minLift per cell, kept aside while attempts are added; see `rollUp`. */
const minLifts = new WeakMap<CellRecord, number>()

/** Cells whose fingerprint came from an attempt that ran, not one that was skipped. */
const measured = new WeakSet<CellRecord>()

const EMPTY_PARTS: FingerprintParts = {
  sources: '',
  harness: '',
  environment: null,
  image: null,
  agentCli: null,
  judge: '',
  context: '',
}

function cellOf(
  entry: EvalEntry,
  cell: Cell,
  gate: CellGate,
  harness: HarnessDescriptor | undefined,
  gateway?: ResolvedGateway,
): CellRecord {
  let found = entry.cells.find((c) => c.key === cell.key)
  if (!found) {
    found = {
      ...cell,
      ...(gateway ? { gateway: gateway.name } : {}),
      fingerprint: '',
      fingerprintParts: EMPTY_PARTS,
      environmentDigest: null,
      harnessKind: harness?.kind ?? 'unknown',
      model: harness ? harnessModel(harness) : null,
      effort: harness ? (harnessEffort(harness) ?? null) : null,
      gate,
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

/**
 * Over the judge's model, threshold and version, and the config's `state` when it sets one: a new
 * judge is a new measurement. `state` set in an eval file is in its sources already.
 */
type JudgeFingerprint = string

async function copyRef(
  ref: FileRef,
  from: string | null | undefined,
  out: Artifacts,
): Promise<FileRef> {
  if (!from) return ref
  const bytes = await readFile(join(from, ...ref.path.split('/'))).catch(() => null)
  if (!bytes) return ref
  return out.add(ref.path, Buffer.from(bytes).toString('utf8'))
}

/** A completed attempt from a previous assemble of this runId, kept on resume. */
async function addPreviousAttempt(
  e: Pick<EngineEval, 'id' | 'key' | 'file' | 'group' | 'name' | 'attempt'>,
  kept: AttemptRecord,
  seen: Seen,
  out: Artifacts,
  judge: JudgeFingerprint,
  previous: RunRecord,
  previousArtifacts?: string | null,
): Promise<void> {
  const before = previous.evals.find((p) => p.id === e.id)
  const beforeCell = before?.cells.find((c) => c.key === kept.cell)
  const cell: Cell = e.attempt?.cell ??
    (beforeCell && {
      key: beforeCell.key,
      harness: beforeCell.harness,
      environment: beforeCell.environment,
      sandbox: beforeCell.sandbox,
      role: beforeCell.role,
      ...(beforeCell.variant !== undefined ? { variant: beforeCell.variant } : {}),
    }) ?? {
      ...UNKNOWN_CELL,
      key: kept.cell,
      harness: kept.cell.split('/')[0] ?? 'unknown',
      environment: kept.cell.split('/')[1] ?? 'unknown',
      sandbox: kept.cell.split('/')[2]?.replace(/#\d+$/, '') ?? 'unknown',
    }
  const sources = before?.sources ?? []
  const stub: EngineEval = {
    id: e.id,
    key: e.key,
    file: e.file,
    group: e.group,
    name: e.name,
    attempt: e.attempt,
    state: 'skipped',
    durationMs: kept.durationMs,
    errors: [],
    formattedErrors: [],
    meta: undefined,
  }
  seen.add(null, cell, stub)
  seen.addKept(previous, kept, cell, beforeCell?.environmentDigest ?? null, e.attempt !== undefined)
  const entry = seen.entry(stub, sources)
  const created = !entry.cells.some((c) => c.key === cell.key)
  const cellRecord = cellOf(
    entry,
    cell,
    e.attempt?.gate ?? beforeCell?.gate ?? 'all',
    e.attempt?.harness,
    e.attempt?.gateway,
  )
  if (created && beforeCell && !e.attempt) {
    cellRecord.harnessKind = beforeCell.harnessKind
    cellRecord.model = beforeCell.model
    cellRecord.effort = beforeCell.effort
    if (beforeCell.gateway !== undefined) cellRecord.gateway = beforeCell.gateway
  }
  // Planned, the eval's own options decide; only an unplanned kept attempt reads the old gate.
  const minLift = e.attempt
    ? e.attempt.minLift
    : (beforeCell?.lift?.minLift ??
      previous.families
        ?.find((f) => f.id === before?.family?.id)
        ?.lifts.find((l) => l.variant === kept.cell)?.minLift)
  if (minLift !== undefined) minLifts.set(cellRecord, minLift)
  const files: AttemptFiles = {}
  for (const [name, ref] of Object.entries(kept.files) as Array<
    [keyof AttemptFiles, AttemptFiles[keyof AttemptFiles]]
  >) {
    if (!ref) continue
    if (Array.isArray(ref)) {
      const copied = []
      for (const art of ref) {
        if (!previousArtifacts) {
          copied.push(art)
          continue
        }
        const bytes = await readFile(join(previousArtifacts, ...art.path.split('/'))).catch(
          () => null,
        )
        copied.push(bytes ? out.addBinary(art.path, bytes) : art)
      }
      if (copied.length) files[name] = copied as never
      continue
    }
    files[name] = (await copyRef(ref, previousArtifacts, out)) as never
  }
  const checks = []
  for (const c of kept.checks) {
    checks.push({
      ...c,
      log: c.log ? await copyRef(c.log, previousArtifacts, out) : c.log,
    })
  }
  const answers = []
  for (const q of kept.answers ?? []) {
    answers.push(q.input ? { ...q, input: await copyRef(q.input, previousArtifacts, out) } : q)
  }
  entry.attempts.push({
    ...kept,
    seq: null,
    files,
    checks,
    ...(answers.length ? { answers } : {}),
  })
  if (measured.has(cellRecord)) return
  measured.add(cellRecord)
  if (beforeCell?.fingerprint) {
    cellRecord.fingerprintParts = beforeCell.fingerprintParts
    cellRecord.fingerprint = beforeCell.fingerprint
    cellRecord.environmentDigest = beforeCell.environmentDigest
    if (cellRecord.overrides.length === 0) cellRecord.overrides = [...beforeCell.overrides]
  } else {
    const parts: FingerprintParts = {
      sources: sha256(JSON.stringify(sources)),
      harness: sha256(JSON.stringify(e.attempt ? withoutCaps(e.attempt.harness) : null)),
      environment: cellRecord.environmentDigest,
      image: kept.imageId,
      agentCli: null,
      judge,
      context: sha256(JSON.stringify(kept.context)),
      ...gatewayPart(e.attempt?.gateway),
    }
    cellRecord.fingerprintParts = parts
    cellRecord.fingerprint = fingerprintOf(parts)
  }
}

/** Reads one attempt's worker record, files its artifacts and adds it to its eval and cell. */
async function addAttempt(
  e: EngineEval,
  ctx: RunContext,
  seen: Seen,
  out: Artifacts,
  judge: JudgeFingerprint,
  previous?: RunRecord | null,
  previousArtifacts?: string | null,
): Promise<void> {
  const cell = e.attempt?.cell ?? UNKNOWN_CELL
  const n = e.attempt?.n ?? 1
  const kept = previousAttempt(previous, e.key)
  if (previous && e.state === 'skipped' && kept && isCompletedAttempt(kept.outcome, kept.error)) {
    await addPreviousAttempt(e, kept, seen, out, judge, previous, previousArtifacts)
    return
  }
  const record = await readRecord(join(ctx.stagingDir, 'evals', recordFileName(e.key)))
  const { outcome, error } = mergeOutcome(e, record)
  if (!seen.sources.has(e.file)) {
    seen.sources.set(e.file, await traceSources(ctx.config.root, e.file))
  }
  const sources = seen.sources.get(e.file) ?? []
  const context = record?.context ?? []
  seen.add(record, cell, e)
  const entry = seen.entry(e, sources)
  // An attempt that ran now saw the files as they are; a kept one may have created the entry.
  if (record) entry.sources = sources
  const cellRecord = cellOf(
    entry,
    cell,
    e.attempt?.gate ?? 'all',
    e.attempt?.harness,
    e.attempt?.gateway,
  )
  if (e.attempt?.minLift !== undefined) minLifts.set(cellRecord, e.attempt.minLift)
  if (record?.environment?.overrides.length && cellRecord.overrides.length === 0) {
    cellRecord.overrides = [...record.environment.overrides]
  }
  const environment = record?.environment
  if (environment && environment.name !== NO_ENVIRONMENT) {
    cellRecord.environmentDigest = environment.digest
  }
  // Skipped attempts never ran, so they have no environment or image to fingerprint.
  if (!cellRecord.fingerprint || record) {
    if (record) measured.add(cellRecord)
    const parts: FingerprintParts = {
      sources: sha256(JSON.stringify(sources)),
      harness: sha256(JSON.stringify(e.attempt ? withoutCaps(e.attempt.harness) : null)),
      environment: environment?.digest ?? null,
      image: record?.image?.id ?? null,
      agentCli: record?.image?.agentCli ?? null,
      judge,
      context: sha256(JSON.stringify(context)),
      ...gatewayPart(e.attempt?.gateway),
    }
    cellRecord.fingerprintParts = parts
    cellRecord.fingerprint = fingerprintOf(parts)
  }
  entry.attempts.push({
    key: attemptKey(entry.key, cell.key, n),
    id: attemptId(cell.key, n),
    cell: cell.key,
    n,
    seq: null,
    startedAt: record?.startedAt ?? null,
    imageId: record?.image?.id ?? null,
    env: record?.env ?? { vars: [], secrets: [], brokered: [] },
    context,
    egress: record?.egress ?? null,
    servedModels: record?.servedModels ?? null,
    ...(record?.askedModels?.length ? { askedModels: record.askedModels } : {}),
    ...(record?.upstreams?.length ? { upstreams: record.upstreams } : {}),
    ...(record?.reportedCostUsd !== undefined ? { reportedCostUsd: record.reportedCostUsd } : {}),
    effort: e.attempt ? (harnessEffort(e.attempt.harness) ?? null) : null,
    servedEffort:
      servedEffortOf([
        ...(record?.servedModels ?? []),
        ...(record?.turns ?? []).map((t) => t.model),
      ]) ?? null,
    outcome,
    error,
    durationMs: e.durationMs,
    ...(await attemptEvidence(
      record,
      `${entry.slug}/${evalSlug(cell.key)}/${n}`,
      out,
      join(ctx.stagingDir, 'evals', recordFileName(e.key)),
    )),
  })
}

/** Turns, timings, activity, verdicts, checks and changed files, with their artifact files. */
async function attemptEvidence(
  record: EvalRecord | null,
  dir: string,
  out: Artifacts,
  stagingRecord?: string,
): Promise<
  Pick<
    AttemptRecord,
    | 'turns'
    | 'usage'
    | 'timings'
    | 'activity'
    | 'judgements'
    | 'startRetries'
    | 'checks'
    | 'changedFiles'
    | 'files'
  >
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
  if (record?.artifacts?.length && stagingRecord) {
    const sidecar = stagingRecord.replace(/\.json$/, '.artifacts')
    const artifacts = []
    for (const art of record.artifacts) {
      const png = await readFile(join(sidecar, `${art.name}.png`)).catch(() => null)
      if (!png) continue
      artifacts.push({
        ...out.addBinary(`${dir}/artifacts/${art.name}.png`, png),
        name: art.name,
        mediaType: art.mediaType,
        capture: art.capture,
      })
    }
    if (artifacts.length) files.artifacts = artifacts
  }
  const judgements: JudgementRecord[] = (record?.judgements ?? []).map((j, i) => ({
    ...j,
    key: judgementKey(i, j.question),
  }))
  return {
    turns: (record?.turns ?? []).map((t) => ({
      prompt: t.prompt,
      status: t.status,
      startedAt: t.startedAt,
      durationMs: t.durationMs,
      usage: t.usage ?? null,
      model: t.model ?? null,
      unreported: t.unreported ?? [],
      error: turnError(t.transcript),
      ...(t.mcpStartup ? { mcpStartup: t.mcpStartup } : {}),
      text:
        t.text.length > TURN_TEXT_LIMIT
          ? `${t.text.slice(0, TURN_TEXT_LIMIT)}… [reeval: truncated ${t.text.length} characters; the whole message is the turn's last text event in transcript.jsonl]`
          : t.text,
    })),
    usage: sumUsage((record?.turns ?? []).map((t) => t.usage)),
    ...(record?.captureUse ? { captureUse: record.captureUse } : {}),
    timings: record?.timings ?? { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
    activity: record
      ? activity(record)
      : {
          tools: 0,
          fileEdits: 0,
          webSearches: 0,
          webFetches: 0,
          reasoningMs: 0,
          stalledTools: 0,
          maxToolMs: null,
        },
    judgements,
    ...(record?.startRetries?.length ? { startRetries: record.startRetries } : {}),
    ...(record?.assertions?.length ? { assertions: record.assertions } : {}),
    checks: (record?.checks ?? []).map((c, i) => ({
      command: c.command,
      exitCode: c.exitCode,
      durationMs: c.durationMs,
      log: out.add(`${dir}/checks/${i + 1}.log`, checkLog(c)),
      ...(c.retries && c.tries
        ? {
            retries: c.retries,
            tries: c.tries.map((t) => ({ exitCode: t.exitCode, durationMs: t.durationMs })),
          }
        : {}),
    })),
    changedFiles: changedFiles(record?.diff?.files ?? []),
    files,
  }
}

/** Lift of a variant cell over the control on the same harness and sandbox, with its interval. */
function liftOf(control: CellRecord, variant: CellRecord, pooled: boolean): Lift | undefined {
  if (control.passRate === null || variant.passRate === null) return undefined
  // A pooled family's minLift gates its pooled lift (`familiesOf`), not each case's.
  const minLift = pooled ? undefined : minLifts.get(variant)
  const c = { pass: control.pass, counted: control.pass + control.fail }
  const v = { pass: variant.pass, counted: variant.pass + variant.fail }
  const { points, low, high } = liftInterval(
    { pass: v.pass, n: v.counted },
    { pass: c.pass, n: c.counted },
  )
  return {
    vs: control.key,
    control: c,
    variant: v,
    points: round3(points),
    interval: { lo: round3(low), hi: round3(high), level: 0.95, method: 'newcombe-wilson' },
    withinNoise: containsZero(low, high),
    ...(minLift !== undefined ? { minLift } : {}),
  }
}

/**
 * Each cell's checks: every label any attempt of the eval recorded, tallied over the cell's
 * counted attempts (pass or fail). An attempt that counted without reaching a label, because
 * a hard `expect` before it failed, counts it `notRun`.
 */
function checkTallies(entry: EvalEntry): void {
  const labels = [
    ...new Set(entry.attempts.flatMap((a) => (a.assertions ?? []).map((x) => x.label))),
  ]
  if (!labels.length) return
  for (const c of entry.cells) {
    const counted = entry.attempts.filter(
      (a) => a.cell === c.key && (a.outcome === 'pass' || a.outcome === 'fail'),
    )
    if (!counted.length) continue
    c.checks = labels.map((label) => {
      const tally = { label, pass: 0, fail: 0, error: 0, notRun: 0 }
      for (const a of counted) {
        const status = a.assertions?.find((x) => x.label === label)?.status
        if (status === undefined) tally.notRun++
        else tally[status]++
      }
      return tally
    })
  }
}

/** Puts the control's tally beside each of the variant's checks, with whether it discriminates. */
function discrimination(control: CellRecord, variant: CellRecord): void {
  for (const check of variant.checks ?? []) {
    const k = control.checks?.find((x) => x.label === check.label)
    if (!k) continue
    const { label: _label, ...tally } = k
    check.control = tally
    const verdict = checkVerdict(check, k)
    if (verdict) check.verdict = verdict
  }
}

/**
 * A cell's outcome by its gate. `'all'` matches `{ passRate: 1 }`: every counted attempt must
 * pass, and it is an infra error only when nothing counted. `'none'` takes the worst attempt.
 */
export function cellOutcome(outcomes: Outcome[], gate: CellGate): Outcome {
  if (gate === 'none') return worstOutcome(outcomes)
  const required = gate === 'all' ? 1 : gate.passRate
  const rate = passRateOf(outcomes)
  if (rate === null) return worstOutcome(outcomes)
  return rate >= required ? 'pass' : 'fail'
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
      c.outcome = cellOutcome(outcomes, c.gate)
    }
    checkTallies(entry)
    for (const c of entry.cells) {
      if (c.role !== 'variant') continue
      const control = entry.cells.find(
        (x) => x.role === 'control' && x.harness === c.harness && x.sandbox === c.sandbox,
      )
      if (control) discrimination(control, c)
      const lift = control && liftOf(control, c, entry.family !== undefined)
      if (!lift) continue
      c.lift = lift
      if (lift.minLift !== undefined && lift.interval.lo < lift.minLift && c.outcome === 'pass') {
        c.outcome = 'fail'
      }
    }
    entry.outcome = worstOutcome(
      entry.cells.map((c) => (c.gate === 'none' && c.outcome === 'fail' ? 'pass' : c.outcome)),
    )
    const gated = new Set(entry.cells.filter((c) => c.gate !== 'none').map((c) => c.key))
    entry.passRate = passRateOf(
      entry.attempts.filter((a) => gated.has(a.cell)).map((a) => a.outcome),
    )
    entry.fingerprint = sha256(
      JSON.stringify(entry.cells.map((c) => [c.key, c.fingerprint]).sort()),
    )
  }
}

/** Start order across the run, by when each attempt's worker began it. */
function sequence(evals: EvalEntry[]): void {
  const started = evals
    .flatMap((e) => e.attempts)
    .filter((a): a is AttemptRecord & { startedAt: string } => a.startedAt !== null)
    .sort((a, b) =>
      a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.key < b.key ? -1 : 1,
    )
  started.forEach((a, i) => {
    a.seq = i + 1
  })
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
    // Kept byte-exact so it applies; recording leaves it out if it looks like it holds a secret.
    out.files.set('worktree.patch', patch)
    state.worktreePatch = { path: 'worktree.patch', sha256: sha256(patch), bytes: patch.length }
  }
  return state
}

const byName =
  <T>(key: (x: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0

function stackOf(
  input: AssembleInput,
  seen: Seen,
  judgeModel: string | null,
  threshold: number,
  stateOptions: ResolvedJudgeStateOptions | undefined,
): Stack {
  const packages = packageVersions(input.enginePackages)
  return {
    reeval: input.reeval,
    node: process.versions.node,
    runtime: input.runtime,
    language: input.language,
    os: process.platform,
    arch: process.arch,
    images: [...seen.images.values()].sort(byName((i) => i.ref)),
    packages,
    harnesses: [...seen.harnesses.values()]
      .map((h) => {
        const resolvedModels = [...(seen.resolvedHarnesses.get(h.id) ?? [])].sort()
        return {
          ...h,
          resolvedModels,
          resolvedEffort: resolvedEffortOf(resolvedModels),
        }
      })
      .sort(byName((h) => h.id)),
    judge: {
      model: judgeModel,
      resolvedModels: [...seen.resolvedJudges].sort(),
      threshold,
      version: judgeVersion(input.reeval, packages, judgeModel ?? ''),
      ...(stateOptions ? { state: stateOptions } : {}),
    },
    context: [...seen.contexts.values()].sort(byName((c) => c.path)),
    fingerprintScope: FINGERPRINT_SCOPE,
  }
}

export async function assembleRun(input: AssembleInput): Promise<AssembledRun> {
  const { ctx, engine } = input
  const { config, runId, profile } = ctx
  const out = new Artifacts()
  const runJudge = profile ? mergeJudge(config.judge, profileJudge(profile)) : config.judge
  const runStateOptions = runJudge.state && resolveStateOptions(runJudge.state)
  const ownStateOptions =
    runStateOptions && JSON.stringify(runStateOptions) !== JSON.stringify(resolveStateOptions({}))
      ? runStateOptions
      : undefined
  const judgeModel = runJudge.model === undefined ? null : judgeModelName(runJudge.model)
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
  const judge = sha256(
    JSON.stringify({
      model: judgeModel,
      threshold: runJudge.threshold,
      version: judgeVersion(input.reeval, packageVersions(input.enginePackages), judgeModel ?? ''),
      ...(ownStateOptions ? { state: ownStateOptions } : {}),
    }),
  )
  for (const e of engine.evals)
    await addAttempt(e, ctx, seen, out, judge, input.previous, input.previousArtifacts)
  if (input.previous) {
    const have = new Set(
      [...seen.byEval.values()].flatMap((entry) => entry.attempts.map((a) => a.key)),
    )
    for (const entry of input.previous.evals) {
      for (const a of entry.attempts) {
        if (have.has(a.key) || !isCompletedAttempt(a.outcome, a.error)) continue
        const stub: EngineEval = {
          id: entry.id,
          key: a.key,
          file: entry.file,
          group: entry.group,
          name: entry.name,
          attempt: undefined,
          state: 'skipped',
          durationMs: a.durationMs,
          errors: [],
          formattedErrors: [],
          meta: undefined,
        }
        await addPreviousAttempt(stub, a, seen, out, judge, input.previous, input.previousArtifacts)
      }
    }
  }
  const evals = [...seen.byEval.values()]
  for (const entry of evals) {
    const before = input.previous?.evals.find((p) => p.id === entry.id)?.family
    if (!entry.family && before) entry.family = before
  }
  rollUp(evals)
  const families = familiesOf(evals, (cell) => minLifts.get(cell))
  sequence(evals)
  for (const e of evals) {
    const asked = input.answers?.evals.get(e.id)
    if (asked?.length) e.answers = asked.map((q) => withInput(e, q, out))
    else if (e.attempts.length && e.attempts.every((a) => seen.kept.has(a.key))) {
      // Every attempt is the previous record's, so its pairwise answers still describe them.
      const before = input.previous?.evals.find((p) => p.id === e.id)?.answers ?? []
      const answers = []
      for (const q of before) {
        answers.push(
          q.input ? { ...q, input: await copyRef(q.input, input.previousArtifacts, out) } : q,
        )
      }
      if (answers.length) e.answers = answers
    }
    for (const a of e.attempts) {
      const own = input.answers?.attempts.get(a.key)
      if (own?.length) a.answers = own.map((q) => withAttemptInput(e, a, q, out))
    }
  }

  const attempts = evals.flatMap((e) => e.attempts)
  const count = (o: Outcome) => attempts.filter((a) => a.outcome === o).length
  const notGated = evals
    .flatMap((e) =>
      e.attempts.filter((a) => e.cells.find((c) => c.key === a.cell)?.gate === 'none'),
    )
    .filter((a) => a.outcome === 'fail').length
  const ids = (list: HarnessDescriptor | HarnessDescriptor[] | undefined) =>
    list === undefined ? undefined : [list].flat().map(harnessId)
  const record: RunRecord = {
    kind: 'reeval-run',
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
    stack: stackOf(input, seen, judgeModel, runJudge.threshold, ownStateOptions),
    environments: [...seen.environments.values()].sort(byName((e) => e.name)),
    profile: profile
      ? {
          name: profile.name,
          reason: profile.reason,
          defaults: JSON.parse(
            JSON.stringify({
              harness: ids(profile.defaults.harness),
              environment: profile.defaults.environment?.name,
              sandbox:
                (profile.defaults.environment || profile.defaults.sandbox) &&
                sandboxId(profileSandbox(config, profile.defaults)),
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
      sandboxWarnings: input.plan.sandboxWarnings,
    },
    budget: Object.keys(input.plan.budget).length ? input.plan.budget : null,
    config: {
      sandbox: plannedSandboxes(input.plan.sandboxes, profileSandbox(config, profile?.defaults)),
      environment: config.environment?.name ?? null,
      runs: config.runs,
      judgeModel,
      threshold: runJudge.threshold,
      timeoutMs: config.timeoutMs,
      concurrency: input.ctx.concurrency,
      configHash,
    },
    cost: costOf(attempts),
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
    ...(families.length ? { families } : {}),
    ...(engine.unhandledErrors.length
      ? { errors: engine.unhandledErrors.map((e) => redactSecrets(e)) }
      : {}),
  }
  return { record, artifacts: out.files }
}
