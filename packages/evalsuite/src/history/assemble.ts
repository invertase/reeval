import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineEval, EngineRun } from '../engine/node.ts'
import { evalSlug, recordFileName, sha256 } from '../ids.ts'
import { judgeModelName } from '../judge/index.ts'
import { patchForJudge } from '../judge/patch.ts'
import { redactSecrets } from '../redact.ts'
import type { EvalRecord, Outcome, ResolvedConfig, RunContext } from '../types.ts'
import {
  type AttemptFiles,
  type AttemptRecord,
  type EvalEntry,
  type FileRef,
  type GitInfo,
  type JudgementRecord,
  type RunnerInfo,
  type RunRecord,
  SCHEMA_VERSION,
} from './types.ts'

const TURN_TEXT_LIMIT = 4096
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
  versions: RunRecord['versions']
  git: GitInfo | null
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

function transcriptLines(record: EvalRecord): string {
  const lines: string[] = []
  record.turns.forEach((turn, index) => {
    lines.push(JSON.stringify({ turn: index, type: 'prompt', text: turn.prompt }))
    for (const event of turn.transcript) {
      if (event.type === 'tool-result') {
        const raw =
          typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2)
        if (raw !== undefined && raw.length > OUTPUT_CAP) {
          lines.push(JSON.stringify({ turn: index, ...event, output: capText(raw) }))
          continue
        }
      }
      lines.push(JSON.stringify({ turn: index, ...event }))
    }
    lines.push(JSON.stringify({ turn: index, type: 'turn-end', status: turn.status }))
  })
  return `${lines.join('\n')}\n`
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

function finalText(record: EvalRecord): string {
  return record.turns
    .map(
      (t, i) =>
        `## Turn ${i + 1}\n\n> ${t.prompt.split('\n').join('\n> ')}\n\n${t.text || '_(no final message)_'}\n`,
    )
    .join('\n')
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

  for (const e of engine.evals) {
    const record = await readRecord(join(ctx.resultsDir, 'evals', recordFileName(e.id)))
    const { outcome, error } = mergeOutcome(e, record)
    if (!sources.has(e.file)) sources.set(e.file, await sourceHash(config.root, e.file))
    const srcHash = sources.get(e.file) ?? null
    const fingerprint = sha256(
      JSON.stringify({
        sourceHash: srcHash,
        harness: config.harness,
        agentCli: input.versions.agentCli,
        image: input.versions.image,
        judge: { model: judgeModel, threshold: config.judge.threshold },
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
      files.final = out.add(`${dir}/final.md`, finalText(record))
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
      log: out.add(`${dir}/checks/${i + 1}.log`, checkLog(c)),
    }))

    const attempt: AttemptRecord = {
      n: 1,
      outcome,
      error,
      durationMs: e.durationMs,
      turns: (record?.turns ?? []).map((t) => ({
        prompt: t.prompt,
        status: t.status,
        text:
          t.text.length > TURN_TEXT_LIMIT
            ? `${t.text.slice(0, TURN_TEXT_LIMIT)}… [see final.md]`
            : t.text,
      })),
      judgements,
      checks,
      changedFiles: record?.diff?.files ?? [],
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
      outcome,
      passRate: counted ? (outcome === 'pass' ? 1 : 0) : null,
      attempts: [attempt],
    })
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
    git: input.git,
    runner: input.runner,
    versions: input.versions,
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
