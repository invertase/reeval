import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type RunTrace, runTrace } from '../src/history/trace.ts'
import type { AttemptRecord, RunRecord } from '../src/history/types.ts'
import type { TranscriptLine } from '../src/view/model.ts'
import { fakeConfig, project, readRun, runCli, tempDir } from './helpers.ts'
import { traceProblems } from './support/trace.ts'

const T0 = Date.parse('2026-11-02T10:00:00.000Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()

/** An attempt that started `at` ms into the run; only the fields the trace reads. */
function attempt(id: string, at: number | null, durationMs: number, extra: object = {}) {
  return {
    key: `evals/a.eval.ts › a # ${id}`,
    id,
    seq: null,
    startedAt: at === null ? null : iso(at),
    outcome: 'pass',
    error: null,
    durationMs,
    turns: [],
    checks: [],
    judgements: [],
    timings: { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
    ...extra,
  } as unknown as AttemptRecord
}

const record = (attempts: AttemptRecord[], durationMs = 60_000) =>
  ({
    runId: 'run-1',
    status: 'complete',
    startedAt: iso(0),
    endedAt: iso(durationMs),
    evals: [{ name: 'a', attempts }],
  }) as unknown as RunRecord

/** The slices of lane `lane`, or of the run's own track. */
const slices = (trace: RunTrace, lane: number | 'run') =>
  trace.traceEvents
    .filter((e) => e.ph === 'X' && (lane === 'run' ? e.pid === 1 : e.pid === 2 && e.tid === lane))
    .map((e) => `${e.name} ${e.ts / 1e6}+${(e.dur as number) / 1e6}`)

describe('reeval show --trace', () => {
  test('lays attempts out in lanes by overlap, leaving out the ones that never started', () => {
    const trace = runTrace(
      record([
        attempt('x#1', 1000, 10_000),
        attempt('x#2', 5000, 10_000),
        attempt('x#3', 11_000, 10_000),
        attempt('x#4', null, 0),
      ]),
    )
    assert.deepEqual(traceProblems(trace), [])
    assert.deepEqual(trace.otherData, { runId: 'run-1', lanes: 2, attempts: 3 })
    assert.deepEqual(slices(trace, 1), ['a x#1 1+10', 'a x#3 11+10'])
    assert.deepEqual(slices(trace, 2), ['a x#2 5+10'])
    assert.deepEqual(slices(trace, 'run'), [
      'run complete 0+60',
      'before the first attempt (plan, preflight) 0+1',
    ])
    const running = trace.traceEvents
      .filter((e) => e.ph === 'C')
      .map((e) => (e.args as { running: number }).running)
    assert.equal(Math.max(...running), 2)
    assert.equal(running.at(-1), 0)
  })

  test('places setup before the first turn and the diff, checks and judge after the last', () => {
    const trace = runTrace(
      record([
        attempt('x#1', 0, 10_000, {
          turns: [
            { prompt: 'p', status: 'completed', startedAt: iso(2000), durationMs: 3000 },
            { prompt: 'q', status: 'completed', startedAt: iso(5500), durationMs: 1000 },
          ],
          checks: [
            { command: 'npm test\n--more', exitCode: 0, durationMs: 400 },
            { command: 'ls', exitCode: 1, durationMs: 100 },
          ],
          judgements: [{ question: 'ok?', verdict: 'pass', score: 1 }],
          timings: { setupMs: 2500, agentMs: 4000, diffMs: 200, checksMs: 600, judgeMs: 5000 },
        }),
      ]),
    )
    assert.deepEqual(traceProblems(trace), [])
    assert.deepEqual(slices(trace, 1), [
      'a x#1 0+10',
      'setup 0+2',
      'turn 1 2+3',
      'turn 2 5.5+1',
      'diff 6.5+0.2',
      'check npm test … 6.7+0.4',
      'check ls 7.1+0.1',
      'judge 7.2+2.8',
    ])
    const setup = trace.traceEvents.find((e) => e.name === 'setup')
    assert.deepEqual(setup?.args, { setupMs: 2500, placed: 'estimated' })
    const judge = trace.traceEvents.find((e) => e.name === 'judge')
    assert.deepEqual(judge?.args, {
      judgeMs: 5000,
      verdicts: ['pass 1: ok?'],
      placed: 'estimated',
    })
  })

  test('nests transcript events under their turn, clipping calls that overlap', () => {
    const a = attempt('x#1', 0, 10_000, {
      turns: [{ prompt: 'p', status: 'completed', startedAt: iso(1000), durationMs: 5000 }],
    })
    const line = (at: number, event: object) =>
      ({ turn: 0, ts: iso(at), atMs: at - 1000, ...event }) as TranscriptLine
    const lines = [
      line(1000, { type: 'prompt', text: 'p' }),
      line(1500, { type: 'tool', tool: 'bash', toolCallId: '1', ok: true, durationMs: 2000 }),
      line(2000, { type: 'tool', tool: 'read', toolCallId: '2', ok: true, durationMs: 2000 }),
      line(4500, { type: 'reasoning', text: 'hm', durationMs: 9000 }),
      line(5000, { type: 'retry', message: 'overloaded' }),
      { turn: 0, type: 'text', text: 'no time', durationMs: 1 } as unknown as TranscriptLine,
    ]
    const trace = runTrace(record([a]), new Map([[a.key, lines]]))
    assert.deepEqual(traceProblems(trace), [])
    assert.deepEqual(slices(trace, 1), [
      'a x#1 0+10',
      'turn 1 1+5',
      'bash 1.5+2',
      'read 2+1.5',
      'reasoning 4.5+1.5',
    ])
    const retry = trace.traceEvents.find((e) => e.name === 'retry')
    assert.deepEqual([retry?.ph, retry?.ts], ['i', 5_000_000])
    const read = trace.traceEvents.find((e) => e.name === 'read')
    assert.deepEqual(read?.args, { ok: true, durationMs: 2000, clippedMs: 500 })
  })

  test('keeps an attempt that started and ended at once as a slice, out of the counter', () => {
    const trace = runTrace(record([attempt('x#1', 1000, 0), attempt('x#2', 2000, 1000)]))
    assert.deepEqual(traceProblems(trace), [])
    assert.deepEqual(slices(trace, 1), ['a x#1 1+0', 'a x#2 2+1'])
    const running = trace.traceEvents
      .filter((e) => e.ph === 'C')
      .map((e) => (e.args as { running: number }).running)
    assert.deepEqual(running, [1, 0])
  })

  test('writes the trace of a run, by default under .reeval/traces', async () => {
    const p = await project('show-trace', {
      'reeval.config.ts': fakeConfig({ harness: `{ files: { 'hello.txt': 'hi\\n' } }` }),
      'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('a', async (c) => {
  await c.send('write hello.txt')
  await expect(c.exec('cat hello.txt')).toSucceed()
})
`,
    })
    assert.equal((await runCli(p.dir, ['run', '--runs', '2'])).code, 0)
    const { run } = readRun(p.dir)
    const shown = await runCli(p.dir, ['show', '--trace'])
    assert.equal(shown.code, 0, shown.stderr)
    const file = join(p.dir, '.reeval', 'traces', `${run.runId}.json`)
    assert.match(shown.stdout, /^Wrote \S+\.json: open it at https:\/\/ui\.perfetto\.dev/)
    const trace = JSON.parse(readFileSync(file, 'utf8')) as RunTrace
    assert.deepEqual(traceProblems(trace), [])
    assert.equal(trace.otherData.attempts, 2)
    const names = new Set(trace.traceEvents.map((e) => e.name))
    for (const name of ['turn 1', 'check cat hello.txt', 'attempts'])
      assert.ok(names.has(name), name)
    const out = join(tempDir('trace-out'), 'nested', 'run.json')
    assert.equal((await runCli(p.dir, ['show', run.runId, '--trace', '--out', out])).code, 0)
    assert.ok(existsSync(out))
    const alone = await runCli(p.dir, ['show', '--out', out])
    assert.notEqual(alone.code, 0)
    assert.match(alone.stderr, /--out is where --trace writes its file/)
    const both = await runCli(p.dir, ['show', '--trace', '--json'])
    assert.notEqual(both.code, 0)
    assert.match(both.stderr, /--trace, --json or --md, one at a time/)

    const liveId = '20261102T180000Z_abc1234_elliot_k3f9'
    const staging = join(p.dir, '.reeval', 'staging', liveId)
    mkdirSync(staging, { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(staging, 'live.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: liveId,
        startedAt: now,
        pid: process.pid,
        host: hostname(),
        heartbeatAt: now,
        phase: 'running',
        planned: 1,
        counts: { done: 0, passed: 0, failed: 0, errored: 0, skipped: 0, running: 1 },
        attempts: [],
      }),
    )
    const live = await runCli(p.dir, ['show', liveId.slice(0, 16), '--trace'])
    assert.notEqual(live.code, 0)
    assert.match(
      live.stderr,
      new RegExp(`${liveId} is still running: .*reeval studio shows it live`),
    )
  })
})
