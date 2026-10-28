import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import type { AttemptRecord, CellRecord, EvalEntry, RunRecord } from '../src/history/types.ts'
import { RefError } from '../src/history/views.ts'
import { attemptKey, evalId } from '../src/ids.ts'
import {
  completedKeysFor,
  HOLDER_FILE,
  isCompletedAttempt,
  keptAttempts,
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
  harness: fakeHarness({}),
  environment: base,
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
    compare: { baseline: base, variants: [skilled], minLift: 0.5 },
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
    const was = first.evals.find((e) => e.name === 'gated')?.cells
    const cells = second.evals.find((e) => e.name === 'gated')?.cells
    const meta = (c: CellRecord) => [c.key, c.role, c.gate, c.harnessKind, c.model, c.overrides]
    assert.deepEqual(cells?.map(meta), was?.map(meta))
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
