import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineEval, EngineRun } from '../engine/node.ts'
import { evalSlug, recordFileName, sha256 } from '../ids.ts'
import { judgeModelName } from '../judge/index.ts'
import { collapseDependencies, patchForJudge } from '../judge/patch.ts'
import type { SandboxVersions } from '../preflight.ts'
import { redactSecrets } from '../redact.ts'
import type { EvalRecord, FileChange, Outcome, ResolvedConfig, RunContext } from '../types.ts'
import { FINGERPRINT_SCOPE, judgeVersion, packageVersions, WORKTREE_PATCH_LIMIT } from './state.ts'
import {
  type AttemptFiles,
  type AttemptRecord,
  type ContextFile,
  type Environment,
  type EvalEntry,
  type FileRef,
  type GitInfo,
  type JudgementRecord,
  type RunnerInfo,
  type RunRecord,
  SCHEMA_VERSION,
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
  const error =
    record?.error ??
    (/timed out/i.test(message)
      ? { kind: 'timeout' as const, message }
      : { kind: 'assertion' as const, message })
  if (/timed out/i.test(message)) error.kind = 'timeout'
  return { outcome: record?.outcome === 'infra_error' ? 'infra_error' : 'fail', error }
}

const harnessModel = (config: ResolvedConfig) =>
  config.harness.kind === 'cursor' ? (config.harness.model ?? null) : null

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

export async function assembleRun(input: AssembleInput): Promise<AssembledRun> {
  const { ctx, engine } = input
  const { config, runId } = ctx
  const out = new Artifacts()
  const judgeModel = judgeModelName(config.judge.model)
  const configHash = sha256(
    JSON.stringify({
      include: config.include,
      harness: config.harness,
      sandbox: config.sandbox,
      judge: config.judge,
      timeoutMs: config.timeoutMs,
    }),
  )
  const sources = new Map<string, string | null>()
  const evals: EvalEntry[] = []
  const contexts = new Map<string, ContextFile>()
  const resolvedJudges = new Set<string>()

  for (const e of engine.evals) {
    const record = await readRecord(join(ctx.resultsDir, 'evals', recordFileName(e.id)))
    const { outcome, error } = mergeOutcome(e, record)
    if (!sources.has(e.file)) sources.set(e.file, await sourceHash(config.root, e.file))
    const srcHash = sources.get(e.file) ?? null
    const context = record?.context ?? []
    for (const c of context) contexts.set(`${c.path}\0${c.sha256}`, c)
    for (const j of record?.judgements ?? [])
      if (j.resolvedModel) resolvedJudges.add(j.resolvedModel)
    const fingerprint = sha256(
      JSON.stringify({
        sourceHash: srcHash,
        harness: config.harness,
        agentCli: input.sandbox.agentCli,
        image: input.sandbox.image?.id ?? null,
        judge: { model: judgeModel, threshold: config.judge.threshold },
        context,
      }),
    )
    const slug = evalSlug(e.id)
    const dir = `${slug}/1`
    const files: AttemptFiles = {}
    const judgements: JudgementRecord[] = (record?.judgements ?? []).map((j) => ({
      ...j,
      reason: null,
      evidence: [],
    }))
    if (record && record.turns.length > 0) {
      files.transcript = out.add(`${dir}/transcript.jsonl`, transcriptLines(record))
      const raw = rawLines(record)
      if (raw) files.rawTranscript = out.add(`${dir}/transcript.raw.jsonl`, raw)
    }
    const patch = record?.diff ? historyPatch(record.diff.patch) : null
    if (patch !== null) files.diff = out.add(`${dir}/diff.patch`, patch)
    if (record?.judgeInputs?.length) {
      files.judgeInput = out.json(
        `${dir}/judge-input.json`,
        judgeInputs(record, patch, 'diff.patch'),
      )
    }
    const checks = (record?.checks ?? []).map((c, i) => ({
      command: c.command,
      exitCode: c.exitCode,
      durationMs: c.durationMs,
      log: out.add(`${dir}/checks/${i + 1}.log`, checkLog(c)),
    }))

    const attempt: AttemptRecord = {
      n: 1,
      context,
      outcome,
      error,
      durationMs: e.durationMs,
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
      checks,
      changedFiles: changedFiles(record?.diff?.files ?? []),
      files,
    }
    const counted = outcome === 'pass' || outcome === 'fail'
    evals.push({
      id: e.id,
      slug,
      file: e.file,
      group: e.group,
      name: e.name,
      fingerprint,
      sourceHash: srcHash,
      fixtureHash: null,
      outcome,
      passRate: counted ? (outcome === 'pass' ? 1 : 0) : null,
      attempts: [attempt],
    })
  }

  let git = input.git
  if (git?.dirty) {
    const patch = input.worktreePatch
    git = { ...git, diffHash: patch ? sha256(patch) : null }
    if (!patch) git.worktreePatchNote = 'git could not produce a patch'
    else if (patch.length > WORKTREE_PATCH_LIMIT) {
      git.worktreePatchNote = `too large to keep (${patch.length} bytes)`
    } else {
      // Kept byte-exact so it applies; recording still refuses it if it looks like a secret.
      out.files.set('worktree.patch', patch)
      git.worktreePatch = { path: 'worktree.patch', sha256: sha256(patch), bytes: patch.length }
    }
  }
  const packages = packageVersions(input.enginePackages)
  const environment: Environment = {
    es: input.es,
    node: process.versions.node,
    os: process.platform,
    arch: process.arch,
    image: input.sandbox.image,
    agentCli: input.sandbox.agentCli,
    packages,
    harness: { kind: config.harness.kind, model: harnessModel(config), resolvedModel: null },
    judge: {
      model: judgeModel,
      resolvedModels: [...resolvedJudges].sort(),
      threshold: config.judge.threshold,
      version: judgeVersion(input.es, packages, judgeModel),
    },
    context: [...contexts.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    fingerprintScope: FINGERPRINT_SCOPE,
  }

  const count = (o: Outcome) => evals.filter((e) => e.outcome === o).length
  const record: RunRecord = {
    kind: 'es-run',
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: input.interrupted ? 'interrupted' : 'complete',
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    author: input.author,
    git,
    runner: input.runner,
    dependencies: { lockfiles: input.lockfiles },
    environment,
    config: {
      harness: config.harness.kind,
      model: harnessModel(config),
      sandbox: config.sandbox.kind,
      judgeModel,
      threshold: config.judge.threshold,
      timeoutMs: config.timeoutMs,
      configHash,
    },
    cost: { usd: null, inputTokens: null, outputTokens: null, source: 'unreported' },
    artifacts: 'all',
    redaction: { version: 1 },
    summary: {
      evals: evals.length,
      pass: count('pass'),
      fail: count('fail'),
      infraError: count('infra_error'),
      skipped: count('skipped'),
    },
    evals,
  }
  return { record, artifacts: out.files }
}
