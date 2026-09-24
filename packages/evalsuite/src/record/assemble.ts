import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineEval, EngineRun } from '../engine/node.ts'
import { evalSlug, recordFileName, runDir, sha256 } from '../ids.ts'
import { judgeModelName } from '../judge/index.ts'
import { redactSecrets } from '../redact.ts'
import type { EvalRecord, Outcome, ResolvedConfig, RunContext } from '../types.ts'
import { renderSummary } from './summary.ts'
import {
  type CheckRecord,
  type EvalEntry,
  type FileRef,
  type GitInfo,
  type JudgementRecord,
  type RunnerInfo,
  type RunRecord,
  SCHEMA_VERSION,
  type TrialFiles,
  type TrialRecord,
} from './types.ts'

const TURN_TEXT_LIMIT = 4096
const SIDECAR_THRESHOLD = 256 * 1024
const SIDECAR_LIMIT = 10 * 1024 * 1024

export type AssembleInput = {
  ctx: RunContext
  engine: EngineRun
  startedAt: Date
  endedAt: Date
  interrupted: boolean
  versions: RunRecord['versions']
  git: GitInfo | null
  runner: RunnerInfo
}

export type AssembledRun = {
  record: RunRecord
  /** Run directory relative to the store root, e.g. `runs/2026/09/<runId>`. */
  dir: string
  /** Every file of the run, keyed by path from the store root. */
  files: Map<string, Uint8Array>
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

const describeHarness = (config: ResolvedConfig) => config.harness.kind
const harnessModel = (config: ResolvedConfig) =>
  config.harness.kind === 'cursor' ? (config.harness.model ?? null) : null

/** Collects files for one run, redacting before anything is hashed. */
class FileSet {
  readonly files = new Map<string, Uint8Array>()
  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  add(relPath: string, content: string): FileRef {
    const bytes = Buffer.from(redactSecrets(content))
    this.files.set(`${this.dir}/${relPath}`, bytes)
    return { path: relPath, sha256: sha256(bytes), bytes: bytes.length }
  }

  json(relPath: string, value: unknown): FileRef {
    return this.add(relPath, `${JSON.stringify(value, null, 2)}\n`)
  }
}

function transcriptLines(record: EvalRecord, files: FileSet, trialDir: string): string {
  const lines: string[] = []
  let seq = 0
  record.turns.forEach((turn, index) => {
    lines.push(JSON.stringify({ turn: index, type: 'prompt', text: turn.prompt }))
    for (const event of turn.transcript) {
      seq++
      if (event.type === 'tool-result') {
        const raw =
          typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2)
        if (raw !== undefined && raw.length > SIDECAR_THRESHOLD) {
          const body =
            raw.length > SIDECAR_LIMIT
              ? `${raw.slice(0, SIDECAR_LIMIT)}\n[truncated: ${raw.length} characters in total]\n`
              : raw
          const ref = files.add(`${trialDir}/tool-output/${seq}.txt`, body)
          lines.push(
            JSON.stringify({
              turn: index,
              ...event,
              output: { sidecar: ref.path, bytes: raw.length },
            }),
          )
          continue
        }
      }
      lines.push(JSON.stringify({ turn: index, ...event }))
    }
    lines.push(JSON.stringify({ turn: index, type: 'turn-end', status: turn.status }))
  })
  return `${lines.join('\n')}\n`
}

const checkLog = (c: EvalRecord['checks'][number]) =>
  `$ ${c.command}\nexit ${c.exitCode}\n--- stdout\n${c.stdout}${c.stdout.endsWith('\n') || !c.stdout ? '' : '\n'}--- stderr\n${c.stderr}${c.stderr.endsWith('\n') || !c.stderr ? '' : '\n'}`

function finalText(record: EvalRecord): string {
  return record.turns
    .map(
      (t, i) =>
        `## Turn ${i + 1}\n\n> ${t.prompt.split('\n').join('\n> ')}\n\n${t.text || '_(no final message)_'}\n`,
    )
    .join('\n')
}

async function sourceHash(root: string, file: string): Promise<string | null> {
  const bytes = await readFile(join(root, file)).catch(() => null)
  return bytes ? sha256(bytes) : null
}

export async function assembleRun(input: AssembleInput): Promise<AssembledRun> {
  const { ctx, engine } = input
  const { config, runId } = ctx
  const dir = runDir(runId)
  const set = new FileSet(dir)
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
    const trialDir = `evals/${slug}/1`
    const files: TrialFiles = {}
    const checks: CheckRecord[] = []
    const judgements: JudgementRecord[] = (record?.judgements ?? []).map((j) => ({
      ...j,
      reason: null,
      evidence: [],
    }))
    if (record && record.turns.length > 0) {
      files.transcript = set.add(
        `${trialDir}/transcript.jsonl`,
        transcriptLines(record, set, trialDir),
      )
      files.final = set.add(`${trialDir}/final.md`, finalText(record))
    }
    if (record?.diff) files.diff = set.add(`${trialDir}/diff.patch`, record.diff.patch)
    if (record?.judgeInputs?.length) {
      files.judgeInput = set.json(`${trialDir}/judge-input.json`, record.judgeInputs)
    }
    record?.checks.forEach((c, i) => {
      const log = set.add(`${trialDir}/checks/${i + 1}.log`, checkLog(c))
      checks.push({ command: c.command, exitCode: c.exitCode, log })
    })

    const trial: TrialRecord = {
      kind: 'es-trial',
      schemaVersion: SCHEMA_VERSION,
      runId,
      evalId: e.id,
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
    const result = set.json(`${trialDir}/result.json`, trial)

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
      trials: [
        {
          n: 1,
          outcome,
          error,
          durationMs: e.durationMs,
          judgements,
          checks,
          changedFiles: trial.changedFiles,
          files,
          result,
        },
      ],
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
    git: input.git,
    runner: input.runner,
    versions: input.versions,
    config: {
      harness: describeHarness(config),
      model: harnessModel(config),
      sandbox: config.sandbox.kind,
      judgeModel,
      threshold: config.judge.threshold,
      timeoutMs: config.timeoutMs,
      configHash,
    },
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
  // The record and summary land last in the file set, marking the run complete.
  set.add('summary.md', renderSummary(record))
  set.json('run.json', record)
  return { record, dir, files: set.files }
}
