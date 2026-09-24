import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineEval, EngineRun } from './engine/node.ts'
import { recordFileName } from './ids.ts'
import type { EsResult, EvalRecord, RunContext } from './types.ts'

const readRecord = async (path: string): Promise<EvalRecord | null> =>
  JSON.parse(await readFile(path, 'utf8').catch(() => 'null'))

function mergeEval(e: EngineEval, record: EvalRecord | null): EsResult['evals'][number] {
  const base = { id: e.id, file: e.file, name: e.name, durationMs: e.durationMs }
  const data = {
    agent: record?.agent ?? null,
    diff: record?.diff ?? null,
    checks: record?.checks ?? [],
    judgements: record?.judgements ?? [],
  }
  if (e.state === 'skipped') return { ...base, ...data, outcome: 'skipped', error: null }
  if (e.state === 'passed') return { ...base, ...data, outcome: 'pass', error: null }
  // The engine may have failed the eval (e.g. on timeout) before the worker finished its record.
  const message = e.errors[0] ?? 'Eval failed'
  const error =
    record?.error ??
    (/timed out/i.test(message)
      ? { kind: 'timeout' as const, message }
      : { kind: 'assertion' as const, message })
  if (/timed out/i.test(message)) error.kind = 'timeout'
  const outcome = record?.outcome === 'infra_error' ? 'infra_error' : 'fail'
  return { ...base, ...data, outcome, error }
}

export async function writeResult(
  ctx: RunContext,
  run: EngineRun,
  meta: { startedAt: Date; versions: EsResult['versions'] },
): Promise<{ result: EsResult; path: string }> {
  const evals = await Promise.all(
    run.evals.map(async (e) =>
      mergeEval(e, await readRecord(join(ctx.resultsDir, 'evals', recordFileName(e.id)))),
    ),
  )
  const count = (o: string) => evals.filter((e) => e.outcome === o).length
  const result: EsResult = {
    schemaVersion: 1,
    runId: ctx.runId,
    startedAt: meta.startedAt.toISOString(),
    durationMs: Date.now() - meta.startedAt.getTime(),
    versions: meta.versions,
    config: {
      harness: ctx.config.harness,
      sandbox: ctx.config.sandbox,
      judgeModel: ctx.config.judge.fake ? 'fake' : ctx.config.judge.model,
    },
    summary: {
      passed: count('pass'),
      failed: count('fail'),
      infraError: count('infra_error'),
      skipped: count('skipped'),
    },
    evals,
  }
  const path = join(ctx.resultsDir, 'result.json')
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  return { result, path }
}
