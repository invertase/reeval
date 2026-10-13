import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { RefError } from '../src/history/views.ts'
import { attemptKey, evalId } from '../src/ids.ts'
import {
  completedKeysFor,
  HOLDER_FILE,
  isCompletedAttempt,
  prepareResume,
  readCurrent,
  resolveResume,
  writeCurrent,
} from '../src/resume.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'
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

  test('a new run prints its id on the plan line and writes .reeval/current', async () => {
    const p = await project('resume-mint', {
      'reeval.config.ts': fakeConfig(),
      'evals/one.eval.ts': `import { evaluate } from 'reeval'\nevaluate('one', async () => {})\n`,
    })
    const r = await runCli(p.dir, ['run', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    assert.match(r.stdout, new RegExp(`run ${run.runId}`))
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
    const id = /run (\S+)/.exec(r.stdout)?.[1]
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

test('writeCurrent overwrites the pointer', async () => {
  const p = await project('resume-pointer-write', { 'reeval.config.ts': fakeConfig() })
  writeCurrent(p.dir, SEEDED_RUN_ID)
  assert.equal(readCurrent(p.dir), SEEDED_RUN_ID)
  writeCurrent(p.dir, '20260102T000000Z_nogit_test_efgh')
  assert.equal(readCurrent(p.dir), '20260102T000000Z_nogit_test_efgh')
  assert.equal(existsSync(join(p.dir, '.reeval', `current.${process.pid}.tmp`)), false)
})
