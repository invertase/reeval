import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { unfoldCases } from '../src/history/cases.ts'
import type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  RunInvocation,
  RunRecord,
} from '../src/history/types.ts'
import { RefError } from '../src/history/views.ts'
import { attemptKey, evalId, recordFileName } from '../src/ids.ts'
import {
  completedKeysFor,
  HOLDER_FILE,
  isCompletedAttempt,
  isKeptAttempt,
  keptAttempts,
  noteRetries,
  prepareResume,
  readCurrent,
  removeStoppedStaging,
  resolveResume,
  resolveRetry,
  restoreRetry,
  resumeSettings,
  savedFilters,
  sweepStaging,
  writeCurrent,
} from '../src/resume.ts'
import { retryCounts, retryLine } from '../src/retry.ts'
import { fakeConfig, noSignals, project, readRun, runCli } from './helpers.ts'
import { SEEDED_RUN_ID, writeScratch, writeStoppedStaging } from './support/resume.ts'

function writeLiveStaging(
  root: string,
  runId: string,
  extra: { pid: number; heartbeatAt: string },
): void {
  writeStoppedStaging(root, runId)
  writeFileSync(
    join(root, '.reeval', 'staging', runId, 'live.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      startedAt: '2026-01-01T00:00:00.000Z',
      pid: extra.pid,
      host: hostname(),
      heartbeatAt: extra.heartbeatAt,
      phase: 'running',
      planned: 0,
      counts: { done: 0, passed: 0, failed: 0, errored: 0, skipped: 0, running: 0 },
      attempts: [],
    })}\n`,
  )
}

describe('isCompletedAttempt', () => {
  test('pass, fail and infra count; skipped and aborted do not', () => {
    assert.equal(isCompletedAttempt('pass', null), true)
    assert.equal(isCompletedAttempt('fail', null), true)
    assert.equal(isCompletedAttempt('infra_error', { kind: 'infra' }), true)
    assert.equal(isCompletedAttempt('skipped', null), false)
    assert.equal(isCompletedAttempt('fail', { kind: 'aborted' }), false)
  })

  test('a resume keeps a pass or a fail, and runs an infra error again', () => {
    assert.equal(isKeptAttempt('pass', null), true)
    assert.equal(isKeptAttempt('fail', null), true)
    assert.equal(isKeptAttempt('infra_error', { kind: 'infra' }), false)
    assert.equal(isKeptAttempt('fail', { kind: 'aborted' }), false)
  })
})

describe('resolveRetry', () => {
  test('omitted ref, latest and latest~N pick finished runs, never a stopped one', async () => {
    const p = await project('retry-latest', { 'reeval.config.ts': fakeConfig() })
    writeScratch(p.dir, '20260101T000000Z_nogit_old_aaaa', 'complete')
    writeScratch(p.dir, '20260102T000000Z_nogit_new_bbbb', 'complete')
    writeStoppedStaging(p.dir, '20260103T000000Z_nogit_stop_cccc')
    writeScratch(p.dir, '20260104T000000Z_nogit_int_dddd', 'interrupted')
    assert.equal((await resolveRetry(p.dir)).runId, '20260102T000000Z_nogit_new_bbbb')
    assert.equal((await resolveRetry(p.dir, 'latest')).runId, '20260102T000000Z_nogit_new_bbbb')
    assert.equal((await resolveRetry(p.dir, 'latest~1')).runId, '20260101T000000Z_nogit_old_aaaa')
    assert.equal((await resolveRetry(p.dir, '20260101')).previous?.status, 'complete')
    await assert.rejects(
      () => resolveRetry(p.dir, '20260104'),
      (e: unknown) =>
        e instanceof UsageError &&
        /didn't finish\. reeval run --resume 20260104T000000Z_nogit_int_dddd/.test(
          (e as Error).message,
        ),
    )
    await assert.rejects(() => resolveRetry(p.dir, 'latest~2'), RefError)
    await assert.rejects(() => resolveRetry(p.dir, 'nope'), RefError)
  })

  test('a live run says when to retry it', async () => {
    const p = await project('retry-live', { 'reeval.config.ts': fakeConfig() })
    const live = '20260101T000000Z_nogit_live_aaaa'
    writeLiveStaging(p.dir, live, { pid: process.pid, heartbeatAt: new Date().toISOString() })
    await assert.rejects(
      () => resolveRetry(p.dir, live),
      (e: unknown) =>
        e instanceof UsageError &&
        /still running\. Wait for it to finish, then reeval run --retry-errors /.test(
          (e as Error).message,
        ),
    )
  })

  test('no finished run is a usage error', async () => {
    const p = await project('retry-none', { 'reeval.config.ts': fakeConfig() })
    writeStoppedStaging(p.dir, SEEDED_RUN_ID)
    await assert.rejects(
      () => resolveRetry(p.dir),
      (e: unknown) =>
        e instanceof UsageError && /No finished run to retry/.test((e as Error).message),
    )
  })
})

describe('resolveResume', () => {
  test('omitted ref and latest pick the newest resumable, not assembled latest', async () => {
    const p = await project('resume-latest', { 'reeval.config.ts': fakeConfig() })
    writeScratch(p.dir, '20260101T000000Z_nogit_old_aaaa', 'complete')
    writeStoppedStaging(p.dir, '20260102T000000Z_nogit_stop_bbbb')
    writeScratch(p.dir, '20260103T000000Z_nogit_new_cccc', 'complete')
    const omitted = await resolveResume(p.dir)
    const latest = await resolveResume(p.dir, 'latest')
    assert.equal(omitted.runId, '20260102T000000Z_nogit_stop_bbbb')
    assert.equal(latest.runId, omitted.runId)
    assert.equal(omitted.kind, 'staging')
  })

  test('a pointer wins when it still names a resumable run', async () => {
    const p = await project('resume-pointer', { 'reeval.config.ts': fakeConfig() })
    writeStoppedStaging(p.dir, '20260101T000000Z_nogit_old_aaaa')
    writeStoppedStaging(p.dir, '20260102T000000Z_nogit_new_bbbb')
    writeCurrent(p.dir, '20260101T000000Z_nogit_old_aaaa')
    const target = await resolveResume(p.dir)
    assert.equal(target.runId, '20260101T000000Z_nogit_old_aaaa')
  })

  test('latest~N walks resumable runs, and a prefix matches one id', async () => {
    const p = await project('resume-back', { 'reeval.config.ts': fakeConfig() })
    writeStoppedStaging(p.dir, '20260101T000000Z_nogit_old_aaaa')
    writeScratch(p.dir, '20260102T000000Z_nogit_int_bbbb', 'interrupted')
    const older = await resolveResume(p.dir, 'latest~1')
    const prefix = await resolveResume(p.dir, '20260102T000000Z_nogit_int')
    assert.equal(older.runId, '20260101T000000Z_nogit_old_aaaa')
    assert.equal(prefix.runId, '20260102T000000Z_nogit_int_bbbb')
    assert.equal(prefix.kind, 'scratch')
  })

  test('a live run and a complete run are refused', async () => {
    const p = await project('resume-refuse', { 'reeval.config.ts': fakeConfig() })
    const live = '20260101T000000Z_nogit_live_aaaa'
    writeLiveStaging(p.dir, live, { pid: process.pid, heartbeatAt: new Date().toISOString() })
    writeScratch(p.dir, '20260102T000000Z_nogit_done_bbbb', 'complete')
    await assert.rejects(
      () => resolveResume(p.dir, live),
      (e: unknown) => e instanceof UsageError && /still running/.test((e as Error).message),
    )
    await assert.rejects(
      () => resolveResume(p.dir, '20260102T000000Z_nogit_done_bbbb'),
      (e: unknown) => e instanceof UsageError && /is complete/.test((e as Error).message),
    )
    await assert.rejects(
      () => resolveResume(p.dir, 'no-such-run'),
      (e: unknown) => e instanceof RefError,
    )
  })

  test('a quiet heartbeat is still running when the pid is alive', async () => {
    const p = await project('resume-sleep', { 'reeval.config.ts': fakeConfig() })
    const live = '20260101T000000Z_nogit_sleep_aaaa'
    writeLiveStaging(p.dir, live, {
      pid: process.pid,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await assert.rejects(
      () => resolveResume(p.dir, live),
      (e: unknown) =>
        e instanceof UsageError &&
        /still running/.test((e as Error).message) &&
        (e as Error).message.includes(live),
    )
  })

  test('omitted ref names a live run instead of no resumable', async () => {
    const p = await project('resume-omitted-live', { 'reeval.config.ts': fakeConfig() })
    const live = '20260101T000000Z_nogit_only_aaaa'
    writeLiveStaging(p.dir, live, { pid: process.pid, heartbeatAt: new Date().toISOString() })
    await assert.rejects(
      () => resolveResume(p.dir),
      (e: unknown) =>
        e instanceof UsageError &&
        /still running/.test((e as Error).message) &&
        (e as Error).message.includes(live),
    )
    const r = await runCli(p.dir, ['run', '--resume'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /still running/)
    assert.match(r.stderr, new RegExp(live))
    assert.doesNotMatch(r.stderr, /No resumable run/)
  })

  test('no resumable run is a usage error', async () => {
    const p = await project('resume-none', { 'reeval.config.ts': fakeConfig() })
    writeScratch(p.dir, '20260101T000000Z_nogit_done_aaaa', 'complete')
    await assert.rejects(
      () => resolveResume(p.dir),
      (e: unknown) => e instanceof UsageError && /No resumable run/.test((e as Error).message),
    )
  })
})

describe('retryCounts', () => {
  const record = (attempts: Array<Partial<AttemptRecord>>) =>
    ({ evals: [{ attempts }] }) as unknown as RunRecord
  const down = { kind: 'infra', message: 'down' }
  test('an attempt a cancel stopped or aborted counts as not finished, not as an error', () => {
    const before = record([
      { key: 'a', outcome: 'infra_error', error: down, startedAt: 't0' },
      { key: 'b', outcome: 'infra_error', error: down, startedAt: 't0' },
      { key: 'c', outcome: 'infra_error', error: down, startedAt: 't0' },
      { key: 'd', outcome: 'infra_error', error: down, startedAt: 't0' },
    ])
    const after = record([
      { key: 'a', outcome: 'infra_error', error: down, startedAt: 't0' },
      {
        key: 'b',
        outcome: 'infra_error',
        error: { kind: 'aborted', message: 'x' },
        startedAt: 't1',
      },
      { key: 'c', outcome: 'infra_error', error: down, startedAt: 't1' },
      { key: 'd', outcome: 'pass', error: null, startedAt: 't1' },
    ])
    const counts = retryCounts(after, new Set(['a', 'b', 'c', 'd']), before)
    assert.deepEqual(counts, { retried: 4, skipped: 2, infra_error: 1, pass: 1 })
    assert.equal(
      retryLine(counts),
      "retried 4 errored attempts: 1 now passes, 0 fail, 1 still errors, 2 didn't finish",
    )
  })
})

describe('noteRetries', () => {
  test("keeps each errored attempt's earlier errors once, from staging and the record", async () => {
    const p = await project('retry-note', { 'reeval.config.ts': fakeConfig() })
    const staging = writeStoppedStaging(p.dir, SEEDED_RUN_ID)
    const key = 'evals/r.eval.ts › e # fake/-/docker#1'
    const at = '2026-01-01T00:00:00.000Z'
    const previous = {
      evals: [
        {
          attempts: [
            {
              key,
              outcome: 'infra_error',
              error: { kind: 'infra', message: 'second' },
              startedAt: at,
              retries: [{ error: { kind: 'infra', message: 'first' }, at: null }],
            },
            { key: 'kept', outcome: 'pass', error: null, startedAt: at },
          ],
        },
      ],
    } as unknown as RunRecord
    const planned = [{ key }, { key: 'kept' }]
    const once = noteRetries(planned, staging, previous, true)
    const twice = noteRetries(planned, staging, previous, true)
    assert.deepEqual([...twice.errored], [key])
    assert.deepEqual(Object.fromEntries(twice.retries), Object.fromEntries(once.retries))
    assert.deepEqual(
      once.retries.get(key)?.map((r) => [r.error.message, r.at]),
      [
        ['first', null],
        ['second', at],
      ],
    )
  })
})

describe('completedKeysFor and prepareResume', () => {
  test('reads completed keys from leftover staging', async () => {
    const p = await project('resume-keys', { 'reeval.config.ts': fakeConfig() })
    const key = attemptKey(evalId('evals/r.eval.ts', ['done']), 'fake/-/docker', 1)
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, [
      { file: 'evals/r.eval.ts', name: 'done', cell: 'fake/-/docker' },
    ])
    const keys = completedKeysFor(
      [{ key }, { key: 'evals/r.eval.ts › leftover # fake/-/docker#1' }],
      join(p.dir, '.reeval', 'staging', SEEDED_RUN_ID),
    )
    assert.deepEqual([...keys], [key])
  })

  test('keptAttempts: the previous assemble wins, else the staged record without a duration', async () => {
    const p = await project('resume-kept', { 'reeval.config.ts': fakeConfig() })
    const staged = attemptKey(evalId('evals/r.eval.ts', ['staged']), 'fake/-/docker', 1)
    const both = attemptKey(evalId('evals/r.eval.ts', ['both']), 'fake/-/docker', 1)
    const staging = writeStoppedStaging(p.dir, SEEDED_RUN_ID, [
      { file: 'evals/r.eval.ts', name: 'staged', cell: 'fake/-/docker' },
      { file: 'evals/r.eval.ts', name: 'both', cell: 'fake/-/docker' },
    ])
    const previous = {
      evals: [
        {
          attempts: [
            { key: both, outcome: 'fail', error: null, startedAt: null, durationMs: 42 },
            { key: 'aborted', outcome: 'fail', error: { kind: 'aborted' }, durationMs: 1 },
          ],
        },
      ],
    } as unknown as RunRecord
    const kept = keptAttempts([staged, both, 'aborted', 'missing'], staging, previous)
    assert.deepEqual(Object.fromEntries(kept), {
      [staged]: { outcome: 'pass', startedAt: '2026-01-01T00:00:00.000Z', durationMs: null },
      [both]: { outcome: 'fail', startedAt: null, durationMs: 42 },
    })
  })

  test('refuses a second claim while this process holds the id', async () => {
    const p = await project('resume-holder', { 'reeval.config.ts': fakeConfig() })
    const runId = '20260101T000000Z_nogit_hold_aaaa'
    writeStoppedStaging(p.dir, runId)
    const target = await resolveResume(p.dir, runId)
    await prepareResume(target, p.dir)
    await assert.rejects(
      () => prepareResume(target, p.dir),
      (e: unknown) => e instanceof UsageError && /still running/.test((e as Error).message),
    )
  })

  test('steals a holder whose process is gone', async () => {
    const p = await project('resume-steal', { 'reeval.config.ts': fakeConfig() })
    const runId = '20260101T000000Z_nogit_dead_aaaa'
    const staging = writeStoppedStaging(p.dir, runId)
    writeFileSync(join(staging, HOLDER_FILE), `2000000000\n${hostname()}\n`)
    const target = await resolveResume(p.dir, runId)
    await prepareResume(target, p.dir)
    assert.match(readFileSync(join(staging, HOLDER_FILE), 'utf8'), new RegExp(String(process.pid)))
  })

  test('moves an interrupted scratch aside so the same id can be rewritten', async () => {
    const p = await project('resume-aside', { 'reeval.config.ts': fakeConfig() })
    const runId = '20260101T000000Z_nogit_int_aaaa'
    const key = 'evals/a.eval.ts › a # fake/-/fake#1'
    writeScratch(p.dir, runId, 'interrupted', [{ key, outcome: 'pass' }])
    const target = await resolveResume(p.dir, runId)
    await prepareResume(target, p.dir)
    assert.equal(existsSync(join(p.dir, '.reeval', 'runs', `${runId}.json`)), false)
    assert.equal(existsSync(join(p.dir, '.reeval', 'staging', runId, 'previous.json')), true)
    const keys = completedKeysFor(
      [{ key }],
      join(p.dir, '.reeval', 'staging', runId),
      target.previous,
    )
    assert.ok(keys.has(key))
  })
})

describe('reeval run --resume', () => {
  const twoEvals = {
    'reeval.config.ts': fakeConfig(),
    'evals/pair.eval.ts': `
import { evaluate } from 'reeval'
evaluate('done', async () => {})
evaluate('leftover', async () => {})
`,
  }

  test('reuses the leftover id, skips a completed attempt and runs the rest', async () => {
    const p = await project('resume-run', twoEvals)
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, [
      { file: 'evals/pair.eval.ts', name: 'done', cell: 'fake/fake/fake' },
    ])
    const r = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`run ${SEEDED_RUN_ID}`))
    assert.match(r.stdout, /resume/)
    const { run } = readRun(p.dir)
    assert.equal(run.runId, SEEDED_RUN_ID)
    const done = run.evals.find((e) => e.name === 'done')
    const leftover = run.evals.find((e) => e.name === 'leftover')
    assert.equal(done?.outcome, 'pass')
    assert.equal(done?.attempts[0]?.startedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(leftover?.outcome, 'pass')
    assert.notEqual(leftover?.attempts[0]?.startedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(readCurrent(p.dir), SEEDED_RUN_ID)
  })

  test('a completed attempt keeps its outcome when the file fails to load for the rest', async () => {
    const p = await project('resume-load-error', {
      'reeval.config.ts': fakeConfig(),
      'evals/pair.eval.ts': `import { existsSync, writeFileSync } from 'node:fs'
import { evaluate } from 'reeval'
const marker = new URL('../loaded-once', import.meta.url)
if (existsSync(marker)) throw new Error('fixture service unavailable')
writeFileSync(marker, '')
evaluate('done', async () => {})
evaluate('leftover', async () => {})
`,
    })
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, [
      { file: 'evals/pair.eval.ts', name: 'done', cell: 'fake/fake/fake' },
    ])
    const r = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.deepEqual(
      readRun(p.dir).run.evals.map((e) => [e.name, e.outcome, e.attempts[0]?.error?.message]),
      [
        ['done', 'pass', undefined],
        ['leftover', 'fail', 'fixture service unavailable'],
      ],
    )
  })

  test("keeps a kept attempt's capture and the page facts beside it", async () => {
    const server = `require('node:http')
  .createServer((_, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<h1>Not found</h1>')
  })
  .listen(Number(process.env.PORT), '127.0.0.1')`
    const p = await project('resume-capture', {
      'reeval.config.ts': fakeConfig(),
      'evals/shot.eval.ts': `
import { defineEnvironment, evaluate } from 'reeval'
const site = defineEnvironment('site', { files: { 'server.cjs': ${JSON.stringify(server)} } })
evaluate('shot', { environments: site }, async (c) => {
  await c.capture(await c.serve('node server.cjs'), { name: 'home', path: '/login' })
})
`,
    })
    const first = await runCli(p.dir, ['run', '--ui', 'plain'])
    assert.equal(first.code, 0, first.stdout + first.stderr)
    const { run } = readRun(p.dir)
    const scratch = join(p.dir, '.reeval', 'runs', `${run.runId}.json`)
    writeFileSync(scratch, JSON.stringify({ ...run, status: 'interrupted' }))
    const r = await runCli(p.dir, ['run', '--resume', run.runId, '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const resumed = readRun(p.dir)
    const art = resumed.run.evals[0]?.attempts[0]?.files.artifacts?.[0]
    assert.equal(art?.name, 'home')
    assert.equal(art?.capture?.status, 404)
    const page = art?.capture?.page
    assert.match(page?.path ?? '', /artifacts\/home\.capture\.json$/)
    const json = readFileSync(join(p.dir, '.reeval', 'runs', run.runId, page?.path ?? ''), 'utf8')
    assert.equal(createHash('sha256').update(json).digest('hex'), page?.sha256)
    assert.equal(JSON.parse(json).finalUrl, '/login')
  })

  test('--dry-run does not write the pointer or move an interrupted scratch', async () => {
    const p = await project('resume-dry', twoEvals)
    const runId = '20260101T000000Z_nogit_int_dry1'
    writeScratch(p.dir, runId, 'interrupted', [
      { key: 'evals/pair.eval.ts › done # fake/fake/fake#1', outcome: 'pass' },
    ])
    const r = await runCli(p.dir, ['run', '--resume', runId, '--dry-run', '--json'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const plan = JSON.parse(r.stdout) as { runId: string; resume?: { completed: number } }
    assert.equal(plan.runId, runId)
    assert.equal(plan.resume?.completed, 1)
    assert.equal(readCurrent(p.dir), null)
    assert.equal(existsSync(join(p.dir, '.reeval', 'runs', `${runId}.json`)), true)
  })

  test('a new run prints its id in the run header and writes .reeval/current', async () => {
    const p = await project('resume-mint', {
      'reeval.config.ts': fakeConfig(),
      'evals/one.eval.ts': `import { evaluate } from 'reeval'\nevaluate('one', async () => {})\n`,
    })
    const r = await runCli(p.dir, ['run', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    assert.match(r.stdout, new RegExp(`^ +➜ +Run: +${run.runId}$`, 'm'))
    assert.equal(readCurrent(p.dir), run.runId)
  })

  test('GITHUB_OUTPUT and the step summary get the id at start', async () => {
    const p = await project('resume-gha', {
      'reeval.config.ts': fakeConfig(),
      'evals/one.eval.ts': `import { evaluate } from 'reeval'\nevaluate('one', async () => {})\n`,
    })
    const out = join(p.dir, 'github-output')
    const summary = join(p.dir, 'step-summary')
    writeFileSync(out, '')
    writeFileSync(summary, '')
    const r = await runCli(p.dir, ['run', '--dry-run'], {
      env: { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const id = /^ +➜ +Run: +(\S+)$/m.exec(r.stdout)?.[1]
    assert.ok(id)
    assert.match(readFileSync(out, 'utf8'), new RegExp(`run-id=${id}`))
    assert.match(readFileSync(summary, 'utf8'), new RegExp(`run ${id}`))
    assert.equal(readCurrent(p.dir), null)
  })

  test('a complete run cannot be resumed', async () => {
    const p = await project('resume-complete', {
      'reeval.config.ts': fakeConfig(),
      'evals/one.eval.ts': `import { evaluate } from 'reeval'\nevaluate('one', async () => {})\n`,
    })
    const first = await runCli(p.dir, ['run'])
    assert.equal(first.code, 0, first.stdout + first.stderr)
    const { run } = readRun(p.dir)
    const r = await runCli(p.dir, ['run', '--resume', run.runId])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /is complete and cannot be resumed/)
  })
})

describe('the staging sweep', () => {
  const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const age = (root: string, name: string) => {
    const when = twoDaysAgo()
    utimesSync(join(root, '.reeval', 'staging', name), when, when)
  }
  const stagingNames = (root: string) => readdirSync(join(root, '.reeval', 'staging')).sort()
  const oneEval = {
    'reeval.config.ts': fakeConfig(),
    'evals/pair.eval.ts': `
import { evaluate } from 'reeval'
evaluate('done', async () => {})
evaluate('leftover', async () => {})
`,
  }
  const done = [{ file: 'evals/pair.eval.ts', name: 'done', cell: 'fake/fake/fake' }]

  test('keeps stale staging a resume can take and removes what no run can resume', async () => {
    const p = await project('sweep-unit', { 'reeval.config.ts': fakeConfig() })
    const stopped = '20260101T000000Z_nogit_stop_aaaa'
    const empty = '20260102T000000Z_nogit_empty_bbbb'
    const assembled = '20260103T000000Z_nogit_done_cccc'
    const live = '20260104T000000Z_nogit_live_dddd'
    const fresh = '20260105T000000Z_nogit_new_eeee'
    writeStoppedStaging(p.dir, stopped, done)
    writeStoppedStaging(p.dir, empty)
    writeStoppedStaging(p.dir, assembled)
    writeScratch(p.dir, assembled, 'complete')
    writeLiveStaging(p.dir, live, { pid: process.pid, heartbeatAt: new Date().toISOString() })
    writeStoppedStaging(p.dir, fresh)
    mkdirSync(join(p.dir, '.reeval', 'staging', 'stray'))
    for (const name of [stopped, empty, assembled, live, 'stray']) age(p.dir, name)
    assert.deepEqual(await sweepStaging(p.dir), [stopped, empty])
    assert.deepEqual(stagingNames(p.dir), [stopped, empty, live, fresh].sort())
    assert.deepEqual(await sweepStaging(p.dir, stopped), [empty])
  })

  test('a run keeps a stopped run older than a day and names it, so --resume still finishes it', async () => {
    const p = await project('sweep-run', oneEval)
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, done)
    age(p.dir, SEEDED_RUN_ID)
    const r = await runCli(p.dir, ['run', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      new RegExp(
        `run ${SEEDED_RUN_ID} stopped over a day ago and can still be resumed: reeval run --resume ${SEEDED_RUN_ID} finishes it, reeval clean --staging deletes it`,
      ),
    )
    assert.deepEqual(stagingNames(p.dir), [SEEDED_RUN_ID])
    const resumed = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--ui', 'plain'])
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr)
    const { run } = readRun(p.dir, { back: 1 })
    assert.equal(run.runId, SEEDED_RUN_ID)
    const kept = run.evals.find((e) => e.name === 'done')
    assert.equal(kept?.attempts[0]?.startedAt, '2026-01-01T00:00:00.000Z')
  })

  test('--dry-run sweeps nothing, even staging no run can resume', async () => {
    const p = await project('sweep-dry', oneEval)
    const assembled = '20260103T000000Z_nogit_done_cccc'
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, done)
    writeStoppedStaging(p.dir, assembled)
    writeScratch(p.dir, assembled, 'complete')
    for (const name of [SEEDED_RUN_ID, assembled]) age(p.dir, name)
    const r = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /can still be resumed/)
    const resumed = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--dry-run'])
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr)
    assert.deepEqual(stagingNames(p.dir), [SEEDED_RUN_ID, assembled].sort())
  })

  test('reeval clean --staging deletes every stopped run and leaves a running one', async () => {
    const p = await project('sweep-clean', { 'reeval.config.ts': fakeConfig() })
    const live = '20260104T000000Z_nogit_live_dddd'
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, done)
    writeLiveStaging(p.dir, live, { pid: process.pid, heartbeatAt: new Date().toISOString() })
    assert.deepEqual(await removeStoppedStaging(p.dir), [SEEDED_RUN_ID])
    assert.deepEqual(stagingNames(p.dir), [live])
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, done)
    const r = await runCli(p.dir, ['clean', '--staging'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`Removed the staging of 1 stopped run: ${SEEDED_RUN_ID}`))
    assert.deepEqual(stagingNames(p.dir), [live])
  })
})

describe('reeval run --resume keeps how the run was started', () => {
  const evals = {
    'reeval.config.ts': fakeConfig(),
    'evals/pair.eval.ts': `
import { evaluate } from 'reeval'
evaluate('one', { runs: 2 }, async () => {})
evaluate('two', async () => {})
`,
  }

  /** A quit that wrote no record: the progress file carries how the run was started. */
  function quitStaging(dir: string, invocation: RunInvocation) {
    const staging = writeStoppedStaging(dir, SEEDED_RUN_ID)
    const file = join(staging, 'live.json')
    const live = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...live, invocation }))
  }

  type Plan = {
    concurrency: number
    warnings: string[]
    totals: { evals: number; attempts: number }
  }
  const dryPlan = async (dir: string, args: string[] = []) => {
    const r = await runCli(dir, ['run', '--resume', SEEDED_RUN_ID, ...args, '--dry-run', '--json'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    return JSON.parse(r.stdout) as Plan
  }

  test('an interrupted record finishes at the --runs and --concurrency it started with', async () => {
    const p = await project('resume-runs', evals)
    const first = await runCli(p.dir, ['run', 'one', '--runs', '3', '--concurrency', '2'])
    assert.equal(first.code, 0, first.stdout + first.stderr)
    const { run } = readRun(p.dir)
    assert.deepEqual(run.invocation, { runs: 3, concurrency: 2, filters: ['one'], tags: [] })
    for (const e of run.evals) {
      e.attempts = e.attempts.map((a) => (a.n > 1 ? { ...a, outcome: 'skipped', error: null } : a))
    }
    const scratch = join(p.dir, '.reeval', 'runs', `${run.runId}.json`)
    writeFileSync(scratch, JSON.stringify({ ...run, status: 'interrupted' }))
    const r = await runCli(p.dir, ['run', '--resume', run.runId, '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const resumed = readRun(p.dir).run
    assert.equal(resumed.runId, run.runId)
    assert.deepEqual(
      resumed.evals.map((e) => [e.name, e.attempts.map((a) => a.outcome)]),
      [['one', ['pass', 'pass', 'pass']]],
    )
    assert.equal(resumed.config.concurrency, 2)
    assert.deepEqual(resumed.invocation, run.invocation)
  })

  test('a quit without a record plans from its progress file', async () => {
    const p = await project('resume-quit-settings', evals)
    quitStaging(p.dir, { runs: 2, concurrency: 3, filters: ['two'], tags: [] })
    const plan = await dryPlan(p.dir)
    assert.equal(plan.totals.evals, 1)
    assert.equal(plan.totals.attempts, 2)
    assert.equal(plan.concurrency, 3)
  })

  test('another --runs or profile is refused, naming what the run started with', async () => {
    const p = await project('resume-conflict', evals)
    quitStaging(p.dir, { runs: 2, filters: [], tags: [] })
    const runs = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--runs', '1'])
    assert.equal(runs.code, 2, runs.stdout + runs.stderr)
    assert.match(runs.stderr, new RegExp(`run ${SEEDED_RUN_ID} was started with --runs 2`))
    const profile = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--profile', 'ci'])
    assert.equal(profile.code, 2, profile.stdout + profile.stderr)
    assert.match(profile.stderr, /was started without a profile/)
    assert.equal((await dryPlan(p.dir, ['--runs', '2'])).totals.attempts, 4)
  })

  test('a run with no profile resumes with none, whatever picks one now', async () => {
    const p = await project('resume-no-profile', {
      ...evals,
      'reeval.config.ts': fakeConfig({
        extra: `profiles: { wide: { defaults: { runs: 4 } } }, defaultProfile: { ci: 'wide' },`,
      }),
    })
    quitStaging(p.dir, { filters: [], tags: [] })
    const run = (env: NodeJS.ProcessEnv) =>
      runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--dry-run', '--json'], { env })
    const ci = await run({ CI: '1' })
    assert.equal(ci.code, 0, ci.stdout + ci.stderr)
    const plan = JSON.parse(ci.stdout) as Plan & { profile: unknown }
    assert.equal(plan.profile, null)
    assert.equal(plan.totals.attempts, 3)
    writeFileSync(join(p.dir, '.env.local'), 'REEVAL_PROFILE=wide\n')
    const env = await run({ CI: '' })
    assert.equal(env.code, 2, env.stdout + env.stderr)
    assert.match(env.stderr, /was started without a profile/)
  })

  test('a run an older reeval started plans from the flags given, with a note', async () => {
    const p = await project('resume-older', evals)
    writeStoppedStaging(p.dir, SEEDED_RUN_ID)
    const plan = await dryPlan(p.dir, ['--runs', '3'])
    assert.equal(plan.totals.attempts, 6)
    assert.ok(
      plan.warnings.includes(
        `run ${SEEDED_RUN_ID} saved no --runs, profile or filters, so this resume plans with the ones given now`,
      ),
      plan.warnings.join('\n'),
    )
  })

  const split = {
    'reeval.config.ts': fakeConfig(),
    'evals/a/one.eval.ts': `import { evaluate } from 'reeval'\nevaluate('one', async () => {})\n`,
    'evals/b/two.eval.ts': `import { evaluate } from 'reeval'\nevaluate('two', async () => {})\n`,
  }
  const planned = async (cwd: string, runId: string) => {
    const r = await runCli(cwd, ['run', '--resume', runId, '--dry-run', '--json'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    return (JSON.parse(r.stdout) as { totals: { evals: number } }).totals.evals
  }
  /** Started with `args` from `cwd`, then rewritten as interrupted before it ran anything. */
  async function interrupted(dir: string, cwd: string, args: string[]) {
    const r = await runCli(cwd, ['run', ...args])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(dir)
    for (const e of run.evals) {
      e.attempts = e.attempts.map((a) => ({ ...a, outcome: 'skipped', error: null }))
    }
    const scratch = join(dir, '.reeval', 'runs', `${run.runId}.json`)
    writeFileSync(scratch, JSON.stringify({ ...run, status: 'interrupted' }))
    return run
  }

  test('an absolute filter under the root is saved relative to it', async () => {
    const p = await project('resume-filter-abs', split)
    const run = await interrupted(p.dir, p.dir, [join(p.dir, 'evals', 'a')])
    assert.deepEqual(run.invocation?.filters, ['evals/a'])
    assert.equal(await planned(join(p.dir, 'evals', 'b'), run.runId), 1)
  })

  test('an absolute filter naming no path on disk is saved relative to the root', async () => {
    const p = await project('resume-filter-abs-part', split)
    const run = await interrupted(p.dir, p.dir, [join(p.dir, 'evals', 'a', 'on')])
    assert.deepEqual(run.invocation?.filters, ['evals/a/on'])
    assert.ok(!JSON.stringify(run).includes(p.dir))
    assert.equal(await planned(join(p.dir, 'evals', 'b'), run.runId), 1)
  })

  test('a filter typed from a subdirectory resumes from the root', async () => {
    const p = await project('resume-filter-cwd', split)
    const run = await interrupted(p.dir, join(p.dir, 'evals'), ['./a'])
    assert.deepEqual(run.invocation?.filters, ['evals/a'])
    assert.equal(await planned(p.dir, run.runId), 1)
  })

  test('a filter outside the root is saved relative to it, never as a host path', () => {
    const root = join(tmpdir(), 'reeval-saved-filters', 'project')
    const outside = join(tmpdir(), 'reeval-saved-filters')
    mkdirSync(root, { recursive: true })
    assert.deepEqual(savedFilters(root, [outside, 'one', '.'], root), ['..', 'one', '.'])
  })

  test('a filtered resume keeps the attempts it leaves out as not run, and the run incomplete', async () => {
    const p = await project('resume-filter-left-out', split)
    const run = await interrupted(p.dir, p.dir, [])
    const dry = await runCli(p.dir, ['run', '--resume', run.runId, 'one', '--dry-run', '--json'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.ok(
      (JSON.parse(dry.stdout) as { warnings: string[] }).warnings.includes(
        `1 attempt run ${run.runId} planned isn't in this resume's filters: it stays not run and the run stays incomplete. reeval run --resume ${run.runId} runs it`,
      ),
      dry.stdout,
    )
    const r = await runCli(p.dir, ['run', '--resume', run.runId, 'one', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Incomplete: 1 attempt this resume’s filters left out is not run/)
    const filtered = readRun(p.dir).run
    assert.equal(filtered.status, 'interrupted')
    const outcomes = (record: RunRecord) =>
      record.evals.map((e) => [e.name, e.attempts.map((a) => a.outcome)])
    assert.deepEqual(outcomes(filtered), [
      ['one', ['pass']],
      ['two', ['skipped']],
    ])
    assert.equal(filtered.evals[1]?.cells[0]?.key, run.evals[1]?.cells[0]?.key)
    const rest = await runCli(p.dir, ['run', '--resume', run.runId, '--ui', 'plain'])
    assert.equal(rest.code, 0, rest.stdout + rest.stderr)
    const finished = readRun(p.dir).run
    assert.equal(finished.status, 'complete')
    assert.deepEqual(outcomes(finished), [
      ['one', ['pass']],
      ['two', ['pass']],
    ])
    assert.equal(
      finished.evals[0]?.attempts[0]?.startedAt,
      filtered.evals[0]?.attempts[0]?.startedAt,
    )
  })

  test('a filtered resume counts skip and todo evals as done, and says an incomplete run is not recorded', async () => {
    const p = await project('resume-filter-declared', {
      'reeval.config.ts': fakeConfig(),
      'evals/a/one.eval.ts': `import { evaluate } from 'reeval'
evaluate('one', async () => {})
evaluate.skip('sk', async () => {})
`,
      'evals/b/two.eval.ts': `import { evaluate } from 'reeval'
evaluate('two', async () => {})
evaluate.todo('td')
`,
    })
    const pending = await interrupted(p.dir, p.dir, [])
    const scratch = join(p.dir, '.reeval', 'runs', `${pending.runId}.json`)
    const run: RunRecord = JSON.parse(readFileSync(scratch, 'utf8'))
    for (const e of run.evals) {
      if (e.name === 'two') e.attempts = e.attempts.map((a) => ({ ...a, outcome: 'pass' }))
    }
    writeFileSync(scratch, JSON.stringify(run))
    const r = await runCli(p.dir, ['run', '--resume', run.runId, 'evals/a', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /Incomplete|isn't in this resume's filters/)
    const done = readRun(p.dir).run
    assert.equal(done.status, 'complete')
    assert.deepEqual(
      done.evals.map((e) => [e.name, e.outcome, e.todo]),
      [
        ['one', 'pass', false],
        ['sk', 'skipped', false],
        ['two', 'pass', false],
        ['td', 'skipped', true],
      ],
    )
    const left = await interrupted(p.dir, p.dir, [])
    const again = await runCli(p.dir, ['run', '--resume', left.runId, 'evals/a', '--record'])
    assert.equal(again.code, 0, again.stdout + again.stderr)
    assert.match(
      again.stdout,
      new RegExp(
        `Not recorded: run ${left.runId} is incomplete\\. reeval run --resume ${left.runId} --record runs the rest and records it\\.`,
      ),
    )
  })

  test('a filtered resume keeps a left-out case’s where exclusions, and pools only the cases it ran', async () => {
    const files = {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
export default defineConfig({ harnesses: fakeHarness({}) })
`,
      'evals/env.ts': `import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
export const next = defineEnvironment('next-app', { sandbox, traits: { stack: 'next' } })
export const vite = defineEnvironment('vite-app', { sandbox, traits: { stack: 'vite' } })
`,
      'evals/fam.eval.ts': `import { evaluate } from 'reeval'
import { next, vite } from './env.ts'
evaluate('fam', {
  environments: [next, vite],
  cases: ['next', 'vite', 'both'],
  runs: 2,
  gate: { passRate: 0.6 },
  where: ({ case: k, environment }) => k === 'both' || environment.traits.stack === k,
}, async (_c, k) => { if (k === 'next') throw new Error('next fails') })
`,
    }
    const shape = (r: RunRecord) => ({
      status: r.status,
      evals: r.evals.map((e) => ({
        name: e.name,
        outcome: e.outcome,
        verdict: e.verdict,
        excluded: e.excluded,
        cells: e.cells.map((c) => [c.key, c.outcome, c.pass, c.fail, c.skipped]),
        attempts: e.attempts.map((a) => [a.key, a.outcome]),
      })),
      families: r.families?.map(({ lifts, ...f }) => f),
      summary: r.summary,
    })
    const u = await project('resume-filter-cases-u', files)
    assert.equal((await runCli(u.dir, ['run', '--ui', 'plain'])).code, 1)
    const whole = shape(unfoldCases(readRun(u.dir).run))
    assert.equal(whole.families?.[0]?.ran, 3)

    const p = await project('resume-filter-cases', files)
    assert.equal((await runCli(p.dir, ['run', '--ui', 'plain'])).code, 1)
    const started = readRun(p.dir).run
    for (const e of started.evals) {
      e.attempts = e.attempts.map((a) => ({ ...a, outcome: 'skipped', error: null }))
    }
    const scratch = join(p.dir, '.reeval', 'runs', `${started.runId}.json`)
    writeFileSync(scratch, JSON.stringify({ ...started, status: 'interrupted' }))
    const r = await runCli(p.dir, ['run', '--resume', started.runId, '[next]', '[both]'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const part = unfoldCases(readRun(p.dir).run)
    assert.equal(part.status, 'interrupted')
    const vite = part.evals.find((e) => e.name === 'fam [vite]')
    assert.deepEqual(
      vite?.attempts.map((a) => a.outcome),
      ['skipped', 'skipped'],
    )
    assert.deepEqual(vite?.excluded, [{ case: 'vite', environment: 'next-app' }])
    const family = part.families?.[0]
    assert.equal(family?.ran, 2)
    assert.equal(family?.outcome, 'fail')
    assert.deepEqual(
      family?.rates.map((x) => [x.cell, x.cases, x.pass, x.counted, x.outcome]),
      [
        ['fake/next-app/fake', 2, 2, 4, 'fail'],
        ['fake/vite-app/fake', 1, 2, 2, 'pass'],
      ],
    )
    assert.equal((await runCli(p.dir, ['run', '--resume', started.runId])).code, 1)
    assert.deepEqual(shape(unfoldCases(readRun(p.dir).run)), whole)
  })

  test('a resume without --trait plans with the run’s saved --trait', async () => {
    const p = await project('resume-saved-trait', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
export default defineConfig({ harnesses: fakeHarness({}) })
`,
      'evals/grid.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
const next = defineEnvironment('next-app', { sandbox, traits: { stack: 'next' } })
const vite = defineEnvironment('vite-app', { sandbox, traits: { stack: 'vite' } })
evaluate('grid', { environments: [next, vite], runs: 2 }, async () => {})
`,
    })
    assert.equal((await runCli(p.dir, ['run', '--ui', 'plain', '--trait', 'stack=next'])).code, 0)
    const started = readRun(p.dir).run
    assert.deepEqual(started.invocation?.traits, ['stack=next'])
    for (const e of started.evals) {
      e.attempts = e.attempts.map((a) => ({ ...a, outcome: 'skipped', error: null }))
    }
    const scratch = join(p.dir, '.reeval', 'runs', `${started.runId}.json`)
    writeFileSync(scratch, JSON.stringify({ ...started, status: 'interrupted' }))
    const r = await runCli(p.dir, ['run', '--resume', started.runId, '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const resumed = readRun(p.dir).run
    assert.deepEqual(resumed.invocation?.traits, ['stack=next'])
    assert.deepEqual(
      resumed.evals[0]?.cells.map((c) => c.key),
      ['fake/next-app/fake'],
    )
  })

  test("a filtered resume counts a .skip outside its filters as done, from the record's skip", async () => {
    const p = await project('resume-filter-skip-outside', {
      'reeval.config.ts': fakeConfig(),
      'evals/a/one.eval.ts': `import { evaluate } from 'reeval'
evaluate('one', async () => {})
`,
      'evals/b/two.eval.ts': `import { evaluate } from 'reeval'
evaluate('two', async () => {})
evaluate.skip('sk', async () => {})
`,
    })
    const seed = async (marked: boolean) => {
      const pending = await interrupted(p.dir, p.dir, [])
      const scratch = join(p.dir, '.reeval', 'runs', `${pending.runId}.json`)
      const run: RunRecord = JSON.parse(readFileSync(scratch, 'utf8'))
      assert.deepEqual(
        run.evals.map((e) => [e.name, e.skip ?? false]),
        [
          ['one', false],
          ['two', false],
          ['sk', true],
        ],
      )
      for (const e of run.evals) {
        if (e.name === 'two') e.attempts = e.attempts.map((a) => ({ ...a, outcome: 'pass' }))
        if (!marked) delete e.skip
      }
      writeFileSync(scratch, JSON.stringify(run))
      return run.runId
    }
    for (const filter of ['evals/a', 'one']) {
      const runId = await seed(true)
      const r = await runCli(p.dir, ['run', '--resume', runId, filter, '--ui', 'plain'])
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout, /Incomplete|isn't in this resume's filters/, filter)
      const done = readRun(p.dir).run
      assert.equal(done.status, 'complete', filter)
      assert.deepEqual(
        done.evals.map((e) => [e.name, e.outcome, e.skip ?? false]),
        [
          ['one', 'pass', false],
          ['two', 'pass', false],
          ['sk', 'skipped', true],
        ],
        filter,
      )
    }
    // Without the marker (a record from before it), the skip can't be told from a pending attempt.
    const old = await seed(false)
    const r = await runCli(p.dir, ['run', '--resume', old, 'evals/a', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Incomplete: 1 attempt this resume’s filters left out is not run/)
    const left = readRun(p.dir).run
    assert.equal(left.status, 'interrupted')
    const shown = await runCli(p.dir, ['show', left.runId])
    assert.match(shown.stdout, /^not run +sk$/m, shown.stdout)
  })

  test('a filtered resume of a quit keeps what its progress file planned, and exits on what it ran', async () => {
    const p = await project('resume-filter-quit', {
      'reeval.config.ts': fakeConfig(),
      'evals/trio.eval.ts': `import { evaluate } from 'reeval'
evaluate('one', async () => { throw new Error('one fails') })
evaluate('two', async () => {})
evaluate('three', async () => {})
`,
    })
    const file = 'evals/trio.eval.ts'
    const cell = 'fake/fake/fake'
    const staging = writeStoppedStaging(p.dir, SEEDED_RUN_ID, [{ file, name: 'three', cell }])
    const liveFile = join(staging, 'live.json')
    const attempt = (name: string, status: string) => ({
      key: attemptKey(evalId(file, [name]), cell, 1),
      evalId: evalId(file, [name]),
      name,
      file,
      cell,
      n: 1,
      status,
      startedAt: null,
      durationMs: null,
    })
    writeFileSync(
      liveFile,
      JSON.stringify({
        ...JSON.parse(readFileSync(liveFile, 'utf8')),
        invocation: { filters: [], tags: [] },
        planned: 3,
        attempts: [attempt('one', 'queued'), attempt('two', 'running'), attempt('three', 'pass')],
      }),
    )
    const r = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, 'one', '--json'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const json = JSON.parse(r.stdout) as { status: string; outcome: string }
    assert.deepEqual([json.status, json.outcome], ['interrupted', 'fail'])
    const { run } = readRun(p.dir)
    assert.equal(run.status, 'interrupted')
    assert.deepEqual(
      run.evals.map((e) => [e.name, e.attempts.map((a) => [a.cell, a.outcome])]),
      [
        ['one', [[cell, 'fail']]],
        ['two', [[cell, 'skipped']]],
        ['three', [[cell, 'pass']]],
      ],
    )
    const rest = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--ui', 'plain'])
    assert.equal(rest.code, 1, rest.stdout + rest.stderr)
    const finished = readRun(p.dir).run
    assert.equal(finished.status, 'complete')
    assert.deepEqual(
      finished.evals.map((e) => [e.name, e.outcome]),
      [
        ['one', 'fail'],
        ['two', 'pass'],
        ['three', 'pass'],
      ],
    )
  })

  test('--runs that is not a count gets the usual error', async () => {
    const p = await project('resume-runs-nan', evals)
    quitStaging(p.dir, { runs: 2, filters: [], tags: [] })
    const r = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID, '--runs', 'abc'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /--runs must be a whole number of at least 1 \(got abc\)/)
  })

  test('a saved profile the config no longer defines names the resumed run', async () => {
    const p = await project('resume-profile-gone', evals)
    quitStaging(p.dir, { profile: 'gone', filters: [], tags: [] })
    const r = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      new RegExp(
        `run ${SEEDED_RUN_ID} was started with profile gone, which \\S+ no longer defines`,
      ),
    )
  })

  test('another --concurrency wins with a note', async () => {
    const p = await project('resume-concurrency', evals)
    quitStaging(p.dir, { concurrency: 3, filters: [], tags: [] })
    const plan = await dryPlan(p.dir, ['--concurrency', '1'])
    assert.equal(plan.concurrency, 1)
    assert.ok(
      plan.warnings.includes(`concurrency 1 replaces the 3 run ${SEEDED_RUN_ID} was started with`),
      plan.warnings.join('\n'),
    )
  })
})

describe('resumeSettings', () => {
  const saved: RunInvocation = { profile: 'nightly', filters: ['a'], tags: ['slow'] }

  const at = (env: NodeJS.ProcessEnv = {}) => ({ root: join(tmpdir(), 'reeval-no-root'), env })

  test('fills what is left out, and a filter or tag given replaces the run’s', () => {
    const left = resumeSettings('r', saved, { filters: [] }, at())
    assert.deepEqual(left.settings, { profile: 'nightly', filters: ['a'], tag: ['slow'] })
    const other = resumeSettings('r', saved, { filters: ['b'], tag: ['fast'] }, at())
    assert.deepEqual(other.settings, { profile: 'nightly', filters: ['b'], tag: ['fast'] })
  })

  test('REEVAL_PROFILE counts as naming the profile', () => {
    const same = resumeSettings('r', saved, { filters: [] }, at({ REEVAL_PROFILE: 'nightly' }))
    assert.equal(same.settings.profile, undefined)
    assert.throws(
      () => resumeSettings('r', saved, { filters: [] }, at({ REEVAL_PROFILE: 'quick' })),
      (e: unknown) => e instanceof UsageError && /with profile nightly/.test((e as Error).message),
    )
  })
})

describe('reeval run --resume of a budget-stopped record', () => {
  // Both arms of `gated` pass, so its lift of 0 fails minLift 0.5; its pairwise question is
  // answered over both runs. The run completes and is then rewritten as a budget stop.
  const budgeted = {
    'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { base } from './evals/envs.ts'
export default defineConfig({
  harnesses: fakeHarness({}),
  environments: base,
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: { model: fakeAnalysis({ vote: 'A' }) },
})
`,
    'skills/house-greeting/SKILL.md':
      '---\nname: house-greeting\ndescription: The house greeting.\n---\n\nSay "Ahoy".\n',
    'evals/envs.ts': `import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
export const base = defineEnvironment('base', { sandbox, env: { MODE: 'base' } })
export const skilled = base.extendEnvironment('skilled', ({ skill }) => ({
  env: { MODE: 'skilled' },
  skills: [skill.local('../skills')],
}))
`,
    'evals/e.eval.ts': `import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate(
  'gated',
  {
    runs: 2,
    compare: { control: base, variants: [skilled], minLift: 0.5 },
    questions: [{ question: 'Which is cleaner?', across: 'environment', diff: true }],
  },
  async (c) => { await c.send('go') },
)
evaluate('slow', { runs: 2 }, async (c) => { await c.send('x') })
`,
  }

  /** A finished run rewritten as a budget stop that never started the attempts `cut` picks. */
  async function stopped(name: string, cut: (e: EvalEntry, a: AttemptRecord) => boolean) {
    const p = await project(name, budgeted)
    const r = await runCli(p.dir, ['run', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    const gated = run.evals.find((e) => e.name === 'gated')
    assert.ok(gated)
    assert.equal(gated.outcome, 'fail')
    assert.equal(gated.cells.find((c) => c.role === 'variant')?.lift?.minLift, 0.5)
    assert.ok(gated.answers?.[0]?.votes.length)
    assert.ok(gated.answers[0].input)
    run.status = 'budget'
    for (const e of run.evals) {
      e.attempts = e.attempts.map((a) =>
        cut(e, a) ? { ...a, outcome: 'skipped', error: null, files: {}, checks: [] } : a,
      )
    }
    writeFileSync(join(p.dir, '.reeval', 'runs', `${run.runId}.json`), JSON.stringify(run))
    return { dir: p.dir, first: run }
  }

  const slowOnly = (e: EvalEntry) => e.name === 'slow'

  function assertKept(dir: string, first: RunRecord, second: RunRecord) {
    const was = first.evals.find((e) => e.name === 'gated')
    const gated = second.evals.find((e) => e.name === 'gated')
    assert.ok(was && gated)
    assert.equal(gated.outcome, 'fail')
    const variant = gated.cells.find((c) => c.role === 'variant')
    assert.equal(variant?.outcome, 'fail')
    assert.equal(variant?.lift?.minLift, 0.5)
    assert.deepEqual(gated.sources, was.sources)
    assert.ok(gated.sources.length > 0)
    const provenance = (e: EvalEntry) =>
      e.cells.map((c) => [c.key, c.fingerprint, c.fingerprintParts, c.environmentDigest])
    assert.deepEqual(provenance(gated), provenance(was))
    assert.equal(gated.fingerprint, was.fingerprint)
    for (const env of first.environments)
      assert.ok(second.environments.some((x) => x.digest === env.digest))
    assert.deepEqual(gated.answers, was.answers)
    const input = gated.answers?.[0]?.input
    assert.ok(input)
    const bytes = readFileSync(join(dir, '.reeval', 'runs', second.runId, input.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256)
  }

  test('keeps a finished eval’s minLift gate, provenance and pairwise answers', async () => {
    const { dir, first } = await stopped('resume-budget-kept', slowOnly)
    // Edited before the resume: `slow` runs on the new file, `gated` keeps what it ran on.
    writeFileSync(join(dir, 'evals/e.eval.ts'), `${budgeted['evals/e.eval.ts']}// edited\n`)
    const r = await runCli(dir, ['run', '--resume', first.runId, '--ui', 'plain'])
    const second = readRun(dir).run
    assertKept(dir, first, second)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const slow = second.evals.find((e) => e.name === 'slow')
    assert.ok(slow?.attempts.every((a) => a.outcome === 'pass'))
    const file = (e: EvalEntry | undefined) =>
      e?.sources.find((s) => s.path === 'evals/e.eval.ts')?.sha256
    const edited = createHash('sha256')
      .update(readFileSync(join(dir, 'evals/e.eval.ts')))
      .digest('hex')
    assert.equal(file(slow), edited)
    assert.notEqual(file(first.evals.find((e) => e.name === 'gated')), edited)
  })

  test('keeps them for an eval a filtered resume leaves out', async () => {
    const { dir, first } = await stopped('resume-budget-filtered', slowOnly)
    const r = await runCli(dir, ['run', '--resume', first.runId, 'slow', '--ui', 'plain'])
    const second = readRun(dir).run
    assertKept(dir, first, second)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.equal(second.status, 'complete')
    const was = first.evals.find((e) => e.name === 'gated')?.cells
    const cells = second.evals.find((e) => e.name === 'gated')?.cells
    const meta = (c: CellRecord) => [c.key, c.role, c.gate, c.harnessKind, c.model, c.overrides]
    assert.deepEqual(cells?.map(meta), was?.map(meta))
  })

  test('stays budget-stopped while a filtered resume leaves attempts out', async () => {
    const { dir, first } = await stopped(
      'resume-budget-left-out',
      (e, a) => e.name === 'slow' || (a.cell.includes('skilled') && a.n === 2),
    )
    const r = await runCli(dir, ['run', '--resume', first.runId, 'gated', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const second = readRun(dir).run
    assert.equal(second.status, 'budget')
    const slow = second.evals.find((e) => e.name === 'slow')
    assert.deepEqual(
      slow?.attempts.map((a) => a.outcome),
      ['skipped', 'skipped'],
    )
    const gated = second.evals.find((e) => e.name === 'gated')
    assert.ok(gated?.attempts.every((a) => a.outcome === 'pass'))
  })

  test('asks a pairwise question again over the kept and new attempts', async () => {
    const { dir, first } = await stopped(
      'resume-budget-mixed',
      (e, a) => e.name === 'gated' && a.cell.includes('skilled') && a.n === 2,
    )
    const was = first.evals.find((e) => e.name === 'gated')
    const asked = (runs: string, path: string | undefined) =>
      JSON.parse(readFileSync(join(runs, first.runId, path ?? ''), 'utf8'))
    const runs = join(dir, '.reeval', 'runs')
    const before = asked(runs, was?.answers?.[0]?.input?.path)
    const r = await runCli(dir, ['run', '--resume', first.runId, '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const gated = readRun(dir).run.evals.find((e) => e.name === 'gated')
    assert.equal(gated?.attempts.filter((a) => a.outcome === 'pass').length, 4)
    const fingerprints = (e: EvalEntry | undefined) => e?.cells.map((c) => [c.key, c.fingerprint])
    assert.deepEqual(fingerprints(gated), fingerprints(was))
    const answer = gated?.answers?.[0]
    assert.equal(answer?.error, undefined)
    assert.deepEqual(
      answer?.votes.map((v) => [v.run, v.a, v.b, v.swapped]),
      was?.answers?.[0]?.votes.map((v) => [v.run, v.a, v.b, v.swapped]),
    )
    // The kept attempts' turns, diff and checks reach the model as they did the first time.
    assert.deepEqual(asked(runs, answer?.input?.path), before)
  })
})

test('writeCurrent overwrites the pointer', async () => {
  const p = await project('resume-pointer-write', { 'reeval.config.ts': fakeConfig() })
  writeCurrent(p.dir, SEEDED_RUN_ID)
  assert.equal(readCurrent(p.dir), SEEDED_RUN_ID)
  writeCurrent(p.dir, '20260102T000000Z_nogit_test_efgh')
  assert.equal(readCurrent(p.dir), '20260102T000000Z_nogit_test_efgh')
  assert.equal(existsSync(join(p.dir, '.reeval', `current.${process.pid}.tmp`)), false)
})

describe('reeval run --retry-errors', () => {
  const failing = {
    'reeval.config.ts': fakeConfig({
      harness: "process.env.FAIL ? { failWith: 'agent start refused' } : {}",
    }),
    'evals/pair.eval.ts': `
import { evaluate, expect } from 'reeval'
evaluate('passes', async (c) => { await c.send('hi') })
evaluate('fails', async (c) => { await c.send('hi'); expect(1).toBe(2) })
`,
  }
  const outage = { env: { FAIL: '1' } }
  const scratchOf = (dir: string, runId: string) => join(dir, '.reeval', 'runs', `${runId}.json`)
  const attemptsOf = (run: RunRecord) =>
    run.evals.map((e) => [
      e.name,
      e.attempts[0]?.outcome,
      e.attempts[0]?.retries?.map((r) => r.error.message),
    ])

  test('runs the infra errors again into the same run, keeping each error in retries', async () => {
    const p = await project('retry-run', failing)
    const first = await runCli(p.dir, ['run', '--ui', 'plain'], outage)
    assert.equal(first.code, 3, first.stdout + first.stderr)
    const { run: before } = readRun(p.dir)
    const r = await runCli(p.dir, ['run', '--retry-errors', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /resumed, 2 errors to retry/)
    assert.match(r.stdout, /^retried 2 errored attempts: 1 now passes, 1 fails, 0 still error$/m)
    const { run } = readRun(p.dir)
    assert.equal(run.runId, before.runId)
    assert.equal(run.status, 'complete')
    assert.deepEqual(attemptsOf(run), [
      ['passes', 'pass', ['agent start refused']],
      ['fails', 'fail', ['agent start refused']],
    ])
    assert.equal(
      run.evals[0]?.attempts[0]?.retries?.[0]?.at,
      before.evals[0]?.attempts[0]?.startedAt,
    )
    const shown = await runCli(p.dir, ['query', 'runs', '--json'])
    assert.match(shown.stdout, /"pass": 1/)
    const again = await runCli(p.dir, ['run', '--retry-errors', run.runId])
    assert.equal(again.code, 1, again.stdout + again.stderr)
    assert.match(again.stdout, /has no infra errors, so --retry-errors has nothing to run again/)
    const json = await runCli(p.dir, ['run', '--retry-errors', '--json'])
    assert.equal(json.code, 1, json.stdout + json.stderr)
    assert.match(json.stderr, /nothing to run again/)
    assert.equal((JSON.parse(json.stdout) as { outcome: string }).outcome, 'fail')
  })

  test("runs again an attempt the judge's provider never answered", async () => {
    const p = await project('retry-judge-outage', {
      'reeval.config.ts': fakeConfig(),
      'evals/judged.eval.ts': `
import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
const model = fakeJudge({
  score: () => {
    if (process.env.FAIL) throw Object.assign(new Error('rate limit exceeded'), { statusCode: 429 })
    return 0.9
  },
})
evaluate('judged', async (c) => {
  await c.send('hi')
  expect(await c.judge('Is it done?', { model, diff: true })).toPass()
})
`,
    })
    const first = await runCli(p.dir, ['run', '--ui', 'plain'], outage)
    assert.equal(first.code, 3, first.stdout + first.stderr)
    const r = await runCli(p.dir, ['run', '--retry-errors', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^retried 1 errored attempt: 1 now passes, 0 fail, 0 still error$/m)
    const { run } = readRun(p.dir)
    assert.deepEqual(attemptsOf(run), [
      ['judged', 'pass', ['judge failed for "Is it done?" (fake): rate limit exceeded']],
    ])
  })

  test('re-records a recorded run at the level it was recorded at', async () => {
    const p = await project('retry-rerecord-level', failing)
    assert.equal((await runCli(p.dir, ['run'], outage)).code, 3)
    const recorded = await runCli(p.dir, ['record', '--artifacts', 'all'])
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr)
    const r = await runCli(p.dir, ['run', '--retry-errors'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const { run } = readRun(p.dir, { history: 'evals/.history' })
    assert.equal(run.artifacts, 'all', "history.artifacts' default doesn't replace --artifacts all")
    const passed = run.evals.find((e) => e.name === 'passes')?.attempts[0]
    assert.equal(passed?.outcome, 'pass')
    assert.ok(passed?.files.transcript, 'the passing retry keeps its transcript')
  })

  test('leaves a pass and a fail as they were', async () => {
    const p = await project('retry-keeps', failing)
    const first = await runCli(p.dir, ['run'])
    assert.equal(first.code, 1, first.stdout + first.stderr)
    const { run } = readRun(p.dir)
    const passed = run.evals.find((e) => e.name === 'passes')?.attempts[0]
    const failed = run.evals.find((e) => e.name === 'fails')?.attempts[0]
    assert.ok(passed && failed)
    Object.assign(passed, { outcome: 'infra_error', error: { kind: 'infra', message: 'down' } })
    // An hour between the run and its retry, which the run's duration doesn't count.
    run.startedAt = new Date(Date.parse(run.startedAt) - 3_600_000).toISOString()
    run.git = {
      sha: 'a'.repeat(40),
      branch: 'then',
      dirty: false,
      diffHash: null,
      worktreePatch: null,
      worktreePatchNote: null,
      commitTime: '2026-01-01T00:00:00Z',
      shallow: false,
      remote: null,
    }
    writeFileSync(scratchOf(p.dir, run.runId), JSON.stringify(run))
    const r = await runCli(p.dir, ['run', '--retry-errors', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /retried 1 errored attempt: 1 now passes, 0 fail, 0 still error/)
    const { run: after } = readRun(p.dir)
    assert.deepEqual(after.plan, run.plan)
    assert.deepEqual(after.git, run.git)
    assert.equal(after.stack.reeval, run.stack.reeval)
    assert.ok(after.durationMs >= run.durationMs, `${after.durationMs}`)
    assert.ok(after.durationMs < run.durationMs + 600_000, `${after.durationMs}`)
    const kept = after.evals.find((e) => e.name === 'fails')?.attempts[0]
    assert.equal(kept?.startedAt, failed.startedAt)
    assert.equal(kept?.retries, undefined)
    assert.deepEqual(after.evals.find((e) => e.name === 'passes')?.attempts[0]?.retries, [
      { error: { kind: 'infra', message: 'down' }, at: passed.startedAt },
    ])
  })

  test('an edited eval is refused, naming what changed, and the run is left as it was', async () => {
    const p = await project('retry-changed', failing)
    await runCli(p.dir, ['run'], outage)
    const { run } = readRun(p.dir)
    const bytes = readFileSync(scratchOf(p.dir, run.runId))
    const file = join(p.dir, 'evals/pair.eval.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace('toBe(2)', 'toBe(3)'))
    const r = await runCli(p.dir, ['run', '--retry-errors'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      new RegExp(
        `run ${run.runId}'s plan changed since it ran: the eval source of evals/pair\\.eval\\.ts › fails changed`,
      ),
    )
    assert.deepEqual(readFileSync(scratchOf(p.dir, run.runId)), bytes)
    assert.equal(existsSync(join(p.dir, '.reeval', 'staging', run.runId)), false)
  })

  test('another reeval than the run ran on is refused', async () => {
    const p = await project('retry-reeval', failing)
    await runCli(p.dir, ['run'], outage)
    const { run } = readRun(p.dir)
    writeFileSync(
      scratchOf(p.dir, run.runId),
      JSON.stringify({ ...run, stack: { ...run.stack, reeval: '0.0.1' } }),
    )
    const r = await runCli(p.dir, ['run', '--retry-errors'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /ran on reeval 0\.0\.1, and this is \S+\. .* install reeval 0\.0\.1, or start/,
    )
    assert.doesNotMatch(r.stderr, /plan changed|put it back/)
  })

  test('an errored eval gone from the plan is refused', async () => {
    const p = await project('retry-dropped', failing)
    await runCli(p.dir, ['run'], outage)
    const file = join(p.dir, 'evals/pair.eval.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^evaluate\('fails'.*$/m, ''))
    const r = await runCli(p.dir, ['run', '--retry-errors'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /it no longer plans evals\/pair\.eval\.ts › fails # fake\/fake\/fake#1/)
  })

  test('another eval in the plan is refused', async () => {
    const p = await project('retry-added', failing)
    await runCli(p.dir, ['run'], outage)
    writeFileSync(
      join(p.dir, 'evals/more.eval.ts'),
      `import { evaluate } from 'reeval'\nevaluate('more', async () => {})\n`,
    )
    const r = await runCli(p.dir, ['run', '--retry-errors'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /it plans evals\/more\.eval\.ts › more # fake\/fake\/fake#1, which the run didn't/,
    )
  })

  test('filters, --resume beside it and an unfinished run are refused', async () => {
    const p = await project('retry-refuse', failing)
    const filtered = await runCli(p.dir, ['run', '--retry-errors', '--', 'passes'])
    assert.equal(filtered.code, 2, filtered.stdout + filtered.stderr)
    assert.match(filtered.stderr, /leave out filters, --tag and --trait/)
    const both = await runCli(p.dir, ['run', '--retry-errors', '--resume'])
    assert.equal(both.code, 2, both.stdout + both.stderr)
    assert.match(both.stderr, /--resume and --retry-errors both continue a run/)
    writeScratch(p.dir, '20260101T000000Z_nogit_int_aaaa', 'interrupted')
    const unfinished = await runCli(p.dir, ['run', '--retry-errors', '20260101T000000Z_nogit_int'])
    assert.equal(unfinished.code, 2, unfinished.stdout + unfinished.stderr)
    assert.match(unfinished.stderr, /didn't finish\. reeval run --resume/)
  })

  test('--resume runs an interrupted run’s infra errors again too', async () => {
    const p = await project('retry-resume', failing)
    await runCli(p.dir, ['run'], outage)
    const { run } = readRun(p.dir)
    writeFileSync(scratchOf(p.dir, run.runId), JSON.stringify({ ...run, status: 'interrupted' }))
    const r = await runCli(p.dir, ['run', '--resume', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /retried 2 errored attempts: 1 now passes, 1 fails/)
    assert.deepEqual(attemptsOf(readRun(p.dir).run), [
      ['passes', 'pass', ['agent start refused']],
      ['fails', 'fail', ['agent start refused']],
    ])
  })

  test('a recorded run is recorded again with the new outcomes', async () => {
    const p = await project('retry-recorded', failing)
    await runCli(p.dir, ['run'], outage)
    const { run } = readRun(p.dir)
    const recorded = await runCli(p.dir, ['record', run.runId])
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr)
    const r = await runCli(p.dir, ['run', '--retry-errors'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /recorded evals\/\.history\//)
    const history = JSON.parse(
      readFileSync(join(p.dir, 'evals', '.history', `${run.runId}.json`), 'utf8'),
    ) as RunRecord
    assert.deepEqual(attemptsOf(history), [
      ['passes', 'pass', ['agent start refused']],
      ['fails', 'fail', ['agent start refused']],
    ])
  })

  test('a best-of attempt the run skipped stays skipped', async () => {
    const p = await project('retry-best-of', {
      ...failing,
      'evals/best.eval.ts': `
import { evaluate } from 'reeval'
evaluate('best', { runs: { bestOf: 3 } }, async (c) => { await c.send('hi') })
`,
    })
    const first = await runCli(p.dir, ['run', '--concurrency', '1'])
    assert.equal(first.code, 1, first.stdout + first.stderr)
    const { run } = readRun(p.dir)
    const best = run.evals.find((e) => e.name === 'best')?.attempts
    assert.deepEqual(
      best?.map((a) => a.outcome),
      ['pass', 'pass', 'skipped'],
    )
    const passed = run.evals.find((e) => e.name === 'passes')?.attempts[0]
    assert.ok(passed)
    Object.assign(passed, { outcome: 'infra_error', error: { kind: 'infra', message: 'down' } })
    writeFileSync(scratchOf(p.dir, run.runId), JSON.stringify(run))
    const r = await runCli(p.dir, ['run', '--retry-errors', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /retried 1 errored attempt: 1 now passes/)
    const after = readRun(p.dir).run.evals.find((e) => e.name === 'best')?.attempts
    assert.deepEqual(
      after?.map((a) => [a.outcome, a.startedAt]),
      best?.map((a) => [a.outcome, a.startedAt]),
    )
  })

  test('a changed judge is refused', async () => {
    const p = await project('retry-judge', {
      ...failing,
      'reeval.config.ts': fakeConfig({
        harness: "process.env.FAIL ? { failWith: 'agent start refused' } : {}",
        judge: '{ model: fakeJudge({ score: 0.9 }), threshold: process.env.TH ? 0.2 : 0.7 }',
      }),
    })
    await runCli(p.dir, ['run'], outage)
    const { run } = readRun(p.dir)
    const bytes = readFileSync(scratchOf(p.dir, run.runId))
    const r = await runCli(p.dir, ['run', '--retry-errors'], { env: { TH: '1' } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /plan changed since it ran: the judge of /)
    assert.deepEqual(readFileSync(scratchOf(p.dir, run.runId)), bytes)
  })

  test('a changed environment is refused before the run is written back', async () => {
    const config = fakeConfig({
      harness: "process.env.FAIL ? { failWith: 'agent start refused' } : {}",
    }).replace(
      "defineEnvironment('fake', {})",
      "defineEnvironment('fake', { files: { 'm.txt': process.env.M ?? 'a' } })",
    )
    const p = await project('retry-environment', { ...failing, 'reeval.config.ts': config })
    await runCli(p.dir, ['run'], outage)
    const { run } = readRun(p.dir)
    const bytes = readFileSync(scratchOf(p.dir, run.runId))
    const r = await runCli(p.dir, ['run', '--retry-errors'], { env: { M: 'b' } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /plan changed since it ran: the environment of /)
    assert.deepEqual(readFileSync(scratchOf(p.dir, run.runId)), bytes)
    assert.equal(existsSync(join(p.dir, '.reeval', 'staging', run.runId)), false)
  })

  test('a resume that finishes a recorded run records it again', async () => {
    const p = await project('retry-resume-recorded', failing)
    await runCli(p.dir, ['run'], outage)
    const { run } = readRun(p.dir)
    const recorded = await runCli(p.dir, ['record', run.runId])
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr)
    writeFileSync(scratchOf(p.dir, run.runId), JSON.stringify({ ...run, status: 'interrupted' }))
    const r = await runCli(p.dir, ['run', '--resume'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /recorded evals\/\.history\//)
    const history = JSON.parse(
      readFileSync(join(p.dir, 'evals', '.history', `${run.runId}.json`), 'utf8'),
    ) as RunRecord
    assert.deepEqual(attemptsOf(history), [
      ['passes', 'pass', ['agent start refused']],
      ['fails', 'fail', ['agent start refused']],
    ])
  })
})

test("restoreRetry leaves another process's retry alone", async () => {
  const p = await project('retry-restore-held', { 'reeval.config.ts': fakeConfig() })
  const staging = writeStoppedStaging(p.dir, SEEDED_RUN_ID)
  writeFileSync(join(staging, HOLDER_FILE), `${process.ppid}\n${hostname()}\n`)
  writeFileSync(join(staging, 'previous.json'), '{}\n')
  await restoreRetry(p.dir, SEEDED_RUN_ID)
  assert.equal(existsSync(join(staging, 'previous.json')), true)
  assert.equal(existsSync(join(p.dir, '.reeval', 'runs', `${SEEDED_RUN_ID}.json`)), false)
})

describe('reeval run --resume of a --retry-errors a Ctrl-C stopped', () => {
  const slow = (started: string) => ({
    'reeval.config.ts': fakeConfig(),
    'evals/trio.eval.ts': `
import { writeFileSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
evaluate('passes', async (c) => { await c.send('hi') })
evaluate('fails', async (c) => { await c.send('hi'); expect(1).toBe(2) })
evaluate('slow', async (c) => {
  await c.send('hi')
  if (process.env.REEVAL_TEST_SLOW) {
    writeFileSync(${JSON.stringify(started)}, '')
    await new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)))
  }
})
`,
  })
  const scratchOf = (dir: string, runId: string) => join(dir, '.reeval', 'runs', `${runId}.json`)
  const down = { kind: 'infra', message: 'down' }
  const git = {
    sha: 'a'.repeat(40),
    branch: 'then',
    dirty: false,
    diffHash: null,
    worktreePatch: null,
    worktreePatchNote: null,
    commitTime: '2026-01-01T00:00:00Z',
    shallow: false,
    remote: null,
  }

  /** A run whose `passes` and `slow` errored an hour ago, then a retry of it a Ctrl-C stopped. */
  const interruptedRetry = async (name: string) => {
    const dir = join(tmpdir(), `reeval-${name}-${process.pid}-${Date.now()}`)
    const started = join(dir, 'slow.started')
    const p = await project(name, slow(started))
    const first = await runCli(p.dir, ['run', '--concurrency', '1'])
    assert.equal(first.code, 1, first.stdout + first.stderr)
    const { run } = readRun(p.dir)
    for (const e of run.evals) {
      if (e.name === 'fails') continue
      for (const a of e.attempts) Object.assign(a, { outcome: 'infra_error', error: down })
    }
    run.startedAt = new Date(Date.parse(run.startedAt) - 3_600_000).toISOString()
    run.git = git
    writeFileSync(scratchOf(p.dir, run.runId), JSON.stringify(run))
    mkdirSync(dir, { recursive: true })
    let pid = 0
    const retry = runCli(p.dir, ['run', '--retry-errors', '--concurrency', '1'], {
      env: { REEVAL_TEST_SLOW: '1' },
      onOutput: (_, id) => {
        pid = id
        return true
      },
    })
    while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 50))
    process.kill(pid, 'SIGINT')
    const stopped = await retry
    assert.equal(stopped.code, 130, stopped.stdout + stopped.stderr)
    const { run: after } = readRun(p.dir)
    assert.equal(after.status, 'interrupted')
    return { p, run }
  }

  test('finishes it as the retry would, keeping the run’s plan, git and duration', {
    skip: noSignals,
  }, async () => {
    const { p, run } = await interruptedRetry('retry-ctrl-c')
    const r = await runCli(p.dir, ['run', '--resume', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const { run: done } = readRun(p.dir)
    assert.equal(done.runId, run.runId)
    assert.equal(done.status, 'complete')
    assert.deepEqual(done.plan, run.plan)
    assert.deepEqual(done.git, run.git)
    assert.deepEqual(done.dependencies, run.dependencies)
    assert.equal(done.stack.reeval, run.stack.reeval)
    assert.equal(done.retriedAt?.length, 1)
    assert.ok(done.durationMs < run.durationMs + 600_000, `${done.durationMs}`)
    const of = (name: string) => done.evals.find((e) => e.name === name)?.attempts[0]
    assert.equal(of('slow')?.outcome, 'pass')
    assert.deepEqual(
      of('slow')?.retries?.map((x) => x.error.message),
      ['down'],
    )
    assert.equal(
      of('fails')?.startedAt,
      run.evals.find((e) => e.name === 'fails')?.attempts[0]?.startedAt,
    )
  })

  test('refuses a changed plan, as the retry would, and leaves the run as it was', {
    skip: noSignals,
  }, async () => {
    const { p } = await interruptedRetry('retry-ctrl-c-changed')
    const { run } = readRun(p.dir)
    const bytes = readFileSync(scratchOf(p.dir, run.runId))
    const file = join(p.dir, 'evals/trio.eval.ts')
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace("await c.send('hi')\n  if", "await c.send('hey')\n  if"),
    )
    const r = await runCli(p.dir, ['run', '--resume'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /plan changed since it ran: the eval source of evals\/trio\.eval\.ts › slow changed\. --resume finishes run \S+'s --retry-errors/,
    )
    assert.deepEqual(readFileSync(scratchOf(p.dir, run.runId)), bytes)
    assert.equal(existsSync(join(p.dir, '.reeval', 'staging', run.runId)), false)
    const filtered = await runCli(p.dir, ['run', '--resume', '--', 'slow'])
    assert.equal(filtered.code, 2, filtered.stdout + filtered.stderr)
    assert.match(filtered.stderr, /stopped during a --retry-errors/)
  })
})

describe('reeval run --resume of a --retry-errors a kill stopped', () => {
  const scratchOf = (dir: string, runId: string) => join(dir, '.reeval', 'runs', `${runId}.json`)
  const down = { kind: 'infra', message: 'down' }

  /**
   * A run whose `passes` and `slow` errored an hour ago, then a retry of it killed once `passes`
   * passed in staging and while `slow` runs: the retry assembled no record.
   */
  const killedRetry = async (name: string) => {
    const dir = join(tmpdir(), `reeval-${name}-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const started = join(dir, 'slow.started')
    const p = await project(name, {
      'reeval.config.ts': fakeConfig(),
      'evals/trio.eval.ts': `
import { writeFileSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
evaluate('passes', async (c) => { await c.send('hi') })
evaluate('fails', async (c) => { await c.send('hi'); expect(1).toBe(2) })
evaluate('slow', async (c) => {
  await c.send('hi')
  if (process.env.REEVAL_TEST_SLOW) {
    writeFileSync(${JSON.stringify(started)}, '')
    await new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)))
  }
})
`,
    })
    const first = await runCli(p.dir, ['run'])
    assert.equal(first.code, 1, first.stdout + first.stderr)
    const { run } = readRun(p.dir)
    for (const e of run.evals) {
      if (e.name === 'fails') continue
      for (const a of e.attempts) Object.assign(a, { outcome: 'infra_error', error: down })
    }
    run.startedAt = new Date(Date.parse(run.startedAt) - 3_600_000).toISOString()
    writeFileSync(scratchOf(p.dir, run.runId), JSON.stringify(run))
    const passKey = run.evals.find((e) => e.name === 'passes')?.attempts[0]?.key ?? ''
    const staged = join(p.dir, '.reeval', 'staging', run.runId, 'evals', recordFileName(passKey))
    const passed = () => {
      try {
        return (JSON.parse(readFileSync(staged, 'utf8')) as { outcome: string }).outcome === 'pass'
      } catch {
        return false
      }
    }
    let pid = 0
    const retry = runCli(p.dir, ['run', '--retry-errors', '--concurrency', '2'], {
      env: { REEVAL_TEST_SLOW: '1' },
      onOutput: (_, id) => {
        pid = id
        return true
      },
    })
    while (!existsSync(started) || !passed()) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    process.kill(pid, 'SIGKILL')
    await retry
    assert.equal(existsSync(scratchOf(p.dir, run.runId)), false, 'the retry moved the run aside')
    return { p, run }
  }

  test('keeps the attempt that passed in staging before the kill', {
    skip: noSignals,
  }, async () => {
    const { p, run } = await killedRetry('retry-kill-staged')
    const r = await runCli(p.dir, ['run', '--resume'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const { run: done } = readRun(p.dir)
    assert.equal(done.runId, run.runId)
    const passes = done.evals.find((e) => e.name === 'passes')?.attempts[0]
    assert.equal(passes?.outcome, 'pass')
    assert.deepEqual(
      passes?.retries?.map((x) => x.error.message),
      ['down'],
    )
  })

  test('finishes it as the retry would', { skip: noSignals }, async () => {
    const { p, run } = await killedRetry('retry-kill-path')
    const r = await runCli(p.dir, ['run', '--resume'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const { run: done } = readRun(p.dir)
    assert.equal(done.status, 'complete')
    assert.deepEqual(done.plan, run.plan)
    assert.equal(done.retriedAt?.length, 1)
    assert.ok(done.durationMs < run.durationMs + 600_000, `${done.durationMs}`)
    const filtered = await killedRetry('retry-kill-filtered')
    const refused = await runCli(filtered.p.dir, ['run', '--resume', '--', 'slow'])
    assert.equal(refused.code, 2, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /stopped during a --retry-errors/)
  })
})
