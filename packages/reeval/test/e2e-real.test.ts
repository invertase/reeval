// The CLI end to end with each real harness (support/harnesses.ts): `reeval run --record -v` twice on
// one tiny eval (test/e2e/), then `reeval compare` says "same", every `reeval query` view answers, the
// `-v` trace and `.reeval/debug` log exist, and `reeval studio build` builds the recorded history. The fake
// row runs it key-free in Docker. Assertions are on exit codes, files and JSON, never model text.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type CliRun, readRun, recordedRuns, runCli } from './helpers.ts'
import { containersLeft } from './support/containers.ts'
import { fixture } from './support/fixture.ts'
import { harnesses, reserveAttempts, rowEnv, skipRow } from './support/harnesses.ts'

const HISTORY = 'evals/.history'
const VIEWS = ['lift', 'flaky_cells', 'drift', 'failing_attempts', 'eval_trend', 'verdict_flips']

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@reeval.test', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

const ok = (r: CliRun, what: string) =>
  assert.equal(r.code, 0, `${what} exited ${r.code}\n${r.stdout}\n${r.stderr}`)

const json = <T>(r: CliRun, what: string): T => {
  ok(r, what)
  return JSON.parse(r.stdout) as T
}

/** Every file under `dir`, relative to it. */
const filesUnder = (dir: string, prefix = ''): string[] =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(dir, join(prefix, d.name)) : [join(prefix, d.name)],
  )

// One row per harness: the CLI's history, compare and queries don't depend on the provider.
for (const row of harnesses.filter((r) => !r.harness)) {
  describe(`e2e CLI: ${row.id}`, { skip: skipRow(row), concurrency: false }, () => {
    const env = rowEnv(row)
    let dir = ''
    const runs: string[] = []

    test('reeval run --record -v: passes, prints the phase trace, writes .reeval/debug', {
      timeout: 600_000,
    }, async () => {
      reserveAttempts(row, 2, 'e2e')
      const p = await fixture('e2e')
      dir = p.dir
      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-qm', 'e2e')
      const r = await runCli(dir, ['run', '--record', '-v'], { env, timeoutMs: 540_000 })
      ok(r, 'reeval run --record -v')
      for (const phase of ['plan', 'image', 'container', 'harness', 'teardown'])
        assert.match(r.stdout, new RegExp(`\\d\\d:\\d\\d:\\d\\d ${phase} `), `no ${phase} line`)
      const { run } = readRun(dir, { history: HISTORY })
      runs.push(run.runId)
      const logs = filesUnder(join(dir, '.reeval/debug', run.runId)).filter((f) =>
        f.endsWith('debug.log'),
      )
      assert.equal(logs.length, 1, `one attempt's debug.log: ${logs}`)
      const log = join(dir, '.reeval/debug', run.runId, logs[0] as string)
      assert.ok(statSync(log).size > 0)
      assert.match(readFileSync(log, 'utf8'), /Z teardown /)
    })

    test('a second identical run: reeval compare says "same"', { timeout: 600_000 }, async () => {
      assert.ok(dir, 'the first run failed')
      ok(await runCli(dir, ['run', '--record'], { env, timeoutMs: 540_000 }), 'reeval run --record')
      assert.deepEqual(recordedRuns(dir).length, 2)
      const { run } = readRun(dir, { history: HISTORY })
      runs.push(run.runId)
      const cmp = json<{ rows: Array<{ status: string; changes?: string[] }> }>(
        await runCli(dir, ['compare', runs[0] as string, runs[1] as string, '--json'], { env }),
        'reeval compare',
      )
      assert.deepEqual(
        cmp.rows.map((r) => [r.status, r.changes ?? []]),
        [['same', []]],
      )
    })

    test('reeval query: every view answers, and the tables hold both runs', async () => {
      assert.equal(runs.length, 2, 'the runs failed')
      for (const view of VIEWS) json(await runCli(dir, ['query', view, '--json'], { env }), view)
      const trend = json<Array<{ run_id: string; outcome: string }>>(
        await runCli(dir, ['query', 'eval_trend', '--json'], { env }),
        'eval_trend',
      )
      assert.deepEqual(
        trend.map((t) => [t.run_id, t.outcome]).sort(),
        runs.map((id) => [id, 'pass']).sort(),
      )
      const [attempts] = json<Array<{ n: number }>>(
        await runCli(dir, ['query', 'SELECT COUNT(*) AS n FROM attempts', '--json'], { env }),
        'attempts',
      )
      assert.equal(attempts?.n, 2)
    })

    test('reeval history and reeval show read the recorded runs', async () => {
      assert.equal(runs.length, 2, 'the runs failed')
      const history = await runCli(dir, ['history', '--json'], { env })
      ok(history, 'reeval history')
      assert.ok(
        runs.every((id) => history.stdout.includes(id)),
        history.stdout,
      )
      const shown = json<{ runId: string }>(
        await runCli(dir, ['show', 'latest', '--json'], { env }),
        'reeval show',
      )
      assert.equal(shown.runId, runs[1])
    })

    test('reeval studio build: a static site with both runs and their transcripts', async () => {
      assert.equal(runs.length, 2, 'the runs failed')
      const site = join(dir, 'site')
      ok(await runCli(dir, ['studio', 'build', '--out', site], { env }), 'reeval studio build')
      assert.ok(existsSync(join(site, 'index.html')))
      for (const id of runs) assert.ok(existsSync(join(site, 'data/runs', `${id}.json`)), id)
      assert.ok(
        filesUnder(site).some((f) => f.endsWith('transcript.jsonl')),
        'the transcripts are in the site',
      )
    })

    test('no container outlives the runs', async () => {
      for (const id of runs) assert.equal(await containersLeft(id), '', `run ${id} left containers`)
    })
  })
}
