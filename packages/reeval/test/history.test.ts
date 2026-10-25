import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { withUnknownFields } from '../scripts/schema/validate.ts'
import { fingerprintOf } from '../src/history/assemble.ts'
import { HISTORY_GITIGNORE, parseCheckIgnore } from '../src/history/ignore.ts'
import { renderSummary } from '../src/history/summary.ts'
import type { RunRecord } from '../src/history/types.ts'
import { harnessLabel, languageLabel, runtimeLabel } from '../src/view/model.ts'
import { readableRecord } from '../src/view/record.ts'
import {
  baseEnv,
  fakeConfig,
  noSignals,
  project,
  readRun,
  recordedRuns,
  runCli,
  tempDir,
} from './helpers.ts'
import { fixture, testDir } from './support/fixture.ts'

const GIT_ENV = {
  ...baseEnv,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

const HISTORY = 'evals/.history'
const agent = (name = 'agent') => `import { evaluate, expect } from 'reeval'
evaluate('${name}', async (c) => {
  await c.send('write hello.txt')
  expect(await c.judge('Did it write hello.txt?')).toPass()
})
`
const failing = `import { evaluate, expect } from 'reeval'
evaluate('broken', async (c) => {
  await c.send('write hello.txt')
  await expect(c.exec('exit 4')).toSucceed()
})
`
const logged = `import { evaluate, expect } from 'reeval'
evaluate('logged', async (c) => {
  await c.send('write hello.txt')
  await expect(c.exec('echo ok')).toSucceed()
})
`
const harness = (text = 'Wrote it') => `{ files: { 'hello.txt': 'hi\\n' }, text: '${text}' }`

/** A reeval project that is its own committed git repo, with a known author. */
async function gitProject(name: string, files: Record<string, string>, extra = '') {
  const p = await project(name, {
    '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
    'reeval.config.ts': fakeConfig({ harness: harness(), extra }),
    ...files,
  })
  sh(p.dir, 'init', '-q', '-b', 'main')
  sh(p.dir, 'config', 'user.name', 'Test Author')
  sh(p.dir, 'config', 'user.email', 'test@example.com')
  sh(p.dir, 'add', '-A')
  sh(p.dir, 'commit', '-q', '-m', 'init')
  return p
}

const historyJson = async (dir: string, args: string[] = []) => {
  const r = await runCli(dir, ['history', '--json', ...args])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout) as {
    runs: Array<{ runId: string }>
    rows: Array<{ id: string; outcomes: string[] }>
    orphaned: string[]
  }
}

describe('recording runs into evals/.history', () => {
  test('reeval run writes scratch; reeval record promotes it next to the evals', async () => {
    const p = await gitProject('record-basic', { 'evals/agent.eval.ts': agent() })
    assert.equal((await runCli(p.dir)).code, 0)
    assert.deepEqual(recordedRuns(p.dir), [], 'nothing recorded without --record')
    const { run, evals } = readRun(p.dir)
    assert.match(run.runId, /^\d{8}T\d{6}Z_[0-9a-f]{7}_test-author_[0-9a-z]{4}$/)
    assert.equal(run.git?.sha.slice(0, 7), run.runId.split('_')[1])
    assert.deepEqual(
      evals[0]?.trial.egress,
      {
        policy: 'proxy',
        allowed: null,
        recorded: false,
        contacted: [],
        blocked: [],
        expectedBlocked: [],
      },
      'the fake sandbox records no traffic, and the record says so',
    )
    const state = (await runCli(p.dir, ['show', run.runId])).stdout
    assert.match(state, /\n {2}Lockfiles +none found\n/)
    assert.match(state, /\n {2}Images +none \(fake sandbox\)\n/)
    assert.match(state, /\n {2}Judge +fake · threshold 0\.8 · version [0-9a-f]{12}\n/)
    assert.match(state, /\n {2}Context +no skills, rules or MCP config found in the sandbox\n/)

    const r = await runCli(p.dir, ['record'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      new RegExp(`recorded evals/\\.history/${run.runId}\\.json \\+ \\d+ artifact files`),
    )
    assert.match(r.stdout, /Commit it with git/)
    assert.deepEqual(recordedRuns(p.dir), [run.runId])
    const recorded = readRun(p.dir, { history: HISTORY })
    const [e] = recorded.evals
    assert.ok(e)
    assert.equal(recorded.run.artifacts, 'all')
    const trial = e.attempts[0]
    for (const file of ['summary.md', trial?.files.transcript?.path, trial?.files.diff?.path]) {
      assert.ok(file && existsSync(join(recorded.dir, file)), file)
    }
    assert.match(
      recorded.read('summary.md'),
      /### ✓ evals\/agent\.eval\.ts › agent/,
      'passes get detail',
    )
    assert.match(recorded.read('summary.md'), /Last message:\n\n> Wrote it/)
    const [input] = JSON.parse(recorded.read(e.trial.files.judgeInput?.path ?? ''))
    assert.deepEqual(input.state.diff.$ref, 'diff.patch', 'the judge input points at diff.patch')
    assert.equal(sh(p.dir, 'status', '--porcelain'), '?? evals/.history/', 'plain files for git')

    assert.equal(readFileSync(join(p.dir, HISTORY, '.gitignore'), 'utf8'), HISTORY_GITIGNORE)
    assert.match((await runCli(p.dir, ['record', run.runId])).stdout, /already recorded/)

    // The history folder and .reeval/ never make the next run dirty.
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    assert.equal(readRun(p.dir).run.git?.dirty, false)
    assert.equal(recordedRuns(p.dir).length, 2)

    const shown = await runCli(p.dir, ['show', 'latest', '--json'])
    assert.equal((JSON.parse(shown.stdout) as RunRecord).kind, 'reeval-run')
    assert.match((await runCli(p.dir, ['show', run.runId, '--md'])).stdout, /^# reeval run /)
    assert.match(
      (await runCli(p.dir, ['history'])).stdout,
      /✓✓ +2\/2 +evals\/agent\.eval\.ts › agent/,
    )
  })

  test('a parent *.log does not drop recorded logs', async () => {
    const p = await gitProject('record-log-tracked', {
      '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n*.log\n',
      'evals/logged.eval.ts': logged,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const r = await runCli(p.dir, ['record'])
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout + r.stderr, /git ignores/)
    assert.equal(readFileSync(join(p.dir, HISTORY, '.gitignore'), 'utf8'), HISTORY_GITIGNORE)

    const recorded = readRun(p.dir, { history: HISTORY })
    const log = recorded.evals[0]?.trial.checks[0]?.log?.path
    assert.ok(log, 'c.exec writes checks/n.log')
    const logPath = join(HISTORY, recorded.run.runId, log)
    assert.equal(
      spawnSync('git', ['check-ignore', '-q', '--no-index', logPath], {
        cwd: p.dir,
        env: GIT_ENV,
      }).status,
      1,
      `${logPath} is not ignored`,
    )
    sh(p.dir, 'add', HISTORY)
    assert.match(sh(p.dir, 'diff', '--cached', '--name-only'), /checks\/1\.log/)
    assert.match(sh(p.dir, 'diff', '--cached', '--name-only'), /\.gitignore/)
  })

  test('reeval record warns when git still ignores a written file', async () => {
    const p = await gitProject('record-log-ignored', {
      '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n*.log\n',
      'evals/logged.eval.ts': logged,
    })
    mkdirSync(join(p.dir, HISTORY), { recursive: true })
    await writeFile(join(p.dir, HISTORY, '.gitignore'), '# local, no un-ignore\n')
    assert.equal((await runCli(p.dir)).code, 0)
    const r = await runCli(p.dir, ['record'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /^warning: git ignores \d+ recorded file\(s\); they won't be committed:$/m,
    )
    assert.match(r.stdout, /checks\/1\.log {2}ignored by \*\.log \(\.gitignore:\d+\)$/m)
    assert.match(r.stdout, /^recorded evals\/\.history\/\S+\.json/m)
  })

  test('git check-ignore -v lines name the rule and its source', () => {
    assert.deepEqual(parseCheckIgnore('.gitignore:3:*.log\tevals/.history/run/setup.log'), {
      path: 'evals/.history/run/setup.log',
      rule: '*.log',
      source: '.gitignore:3',
    })
    assert.equal(
      parseCheckIgnore('evals/.history/.gitignore:6:!*.log\tevals/.history/run/setup.log'),
      null,
      'a ! un-ignore is not an ignore',
    )
    assert.equal(parseCheckIgnore('not a check-ignore line'), null)
  })

  test('a history file that is not a readable record is named on stderr, not silently skipped', async () => {
    const p = await gitProject('record-unreadable', { 'evals/agent.eval.ts': agent() })
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const [good] = recordedRuns(p.dir)
    // What a merge that went wrong, or a copy cut short, leaves behind.
    const conflicted = `${HISTORY}/20260101T000000Z_deadbee_someone_aaaa.json`
    const truncated = `${HISTORY}/20260101T000001Z_deadbee_someone_bbbb.json`
    await writeFile(join(p.dir, conflicted), '<<<<<<< HEAD\n{"kind":"reeval-run"}\n=======\n')
    await writeFile(join(p.dir, truncated), '{"kind":"reeval-run","runId":"2026')
    for (const args of [['history'], ['history', '--json'], ['query', 'lift', '--rebuild']]) {
      const r = await runCli(p.dir, args)
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`)
      for (const file of [conflicted, truncated]) {
        const warning = `warning: skipped ${file}: not a readable reeval run record`
        assert.equal(
          r.stderr.split(warning).length - 1,
          1,
          `${args.join(' ')} names ${file} once:\n${r.stderr}`,
        )
      }
      // The canary: the readable run is still there.
      if (args[1] === '--json') assert.equal(JSON.parse(r.stdout).runs[0].runId, good)
    }
  })

  test("artifacts 'failures' keeps what a failed eval's compare input and lift gate need", async () => {
    const p = await fixture('features/compare/question-artifacts')
    await rm(join(p.dir, 'evals/lands.eval.ts'))
    await rm(join(p.dir, 'evals/canary.eval.ts'))
    await writeFile(
      join(p.dir, 'evals/mixed.eval.ts'),
      `import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

evaluate(
  'mixed',
  {
    runs: 2,
    compare: { baseline, variants: [variant] },
    questions: [{ question: 'Which page looks better?', across: 'environment', artifacts: ['landing'] }],
  },
  async (c) => {
    await c.send('write the page')
    const server = await c.serve('node server.mjs')
    await c.capture(server, { name: 'aside' })
    await c.capture(server, { name: 'landing' })
    expect(c.attempt.n, 'first try').toBe(1)
  },
)
`,
    )
    await writeFile(
      join(p.dir, 'evals/flat.eval.ts'),
      `import { evaluate } from 'reeval'
import { baseline, variant } from './env.ts'

evaluate('flat', { compare: { baseline, variants: [variant], minLift: 0.5 } }, async (c) => {
  await c.send('write the page')
})
`,
    )
    await writeFile(
      join(p.dir, 'evals/lifted.eval.ts'),
      `import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

evaluate(
  'lifted',
  { runs: 2, compare: { baseline, variants: [variant], minLift: 0.6 } },
  async (c) => {
    await c.send('write the page')
    expect(c.attempt.cell.role === 'variant' || c.attempt.n === 1, 'passes').toBe(true)
  },
)
`,
    )
    assert.equal((await runCli(p.dir)).code, 1)
    const r = await runCli(p.dir, ['record', '--artifacts', 'failures'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run, dir } = readRun(p.dir, { history: HISTORY })
    const evalOf = (name: string) => run.evals.find((e) => e.name === name)
    const mixed = evalOf('mixed')
    assert.equal(mixed?.outcome, 'fail')
    const input = mixed?.answers?.[0]?.input
    assert.ok(input && existsSync(join(dir, input.path)), 'the failed eval keeps its compare input')
    const shots = JSON.parse(readFileSync(join(dir, input.path), 'utf8')).calls.flatMap(
      (c: { screenshots?: { path?: string }[] }) => c.screenshots ?? [],
    )
    assert.ok(shots.length > 0)
    for (const s of shots) assert.ok(s.path && existsSync(join(dir, s.path)), s.path)
    for (const a of mixed?.attempts ?? []) {
      const kept = Object.keys(a.files).sort()
      if (a.outcome === 'fail') assert.ok(a.files.transcript, `${a.id} keeps its transcript`)
      else {
        assert.deepEqual(kept, ['artifacts', 'diff'], `${a.id}: the shown capture and its diff`)
        assert.deepEqual(
          a.files.artifacts?.map((x) => x.name),
          ['landing'],
        )
      }
    }
    const flat = evalOf('flat')
    assert.equal(flat?.outcome, 'fail')
    assert.ok(
      flat?.attempts.every((a) => a.outcome === 'pass' && a.files.transcript),
      'a lift gate that failed with no failed attempt keeps every attempt',
    )
    const lifted = evalOf('lifted')
    const variantCell = lifted?.cells.find((c) => c.role === 'variant')
    assert.equal(variantCell?.outcome, 'fail', 'the variant misses its minLift')
    assert.ok(
      lifted?.attempts
        .filter((a) => a.cell === variantCell?.key)
        .every((a) => a.outcome === 'pass' && a.files.transcript),
      "the lift-failed cell keeps its attempts beside the control's failure",
    )
  })

  test('artifact levels, and config.record modes', async () => {
    const p = await gitProject(
      'record-levels',
      { 'evals/agent.eval.ts': agent(), 'evals/broken.eval.ts': failing },
      `history: { artifacts: 'failures' }, record: 'always',`,
    )
    assert.equal((await runCli(p.dir)).code, 1)
    const recorded = readRun(p.dir, { history: HISTORY })
    assert.equal(recorded.run.artifacts, 'failures')
    const pass = recorded.evals.find((e) => e.outcome === 'pass')
    const fail = recorded.evals.find((e) => e.outcome === 'fail')
    assert.deepEqual(pass?.trial.files, {}, 'no artifacts for the passing eval')
    assert.ok(!existsSync(join(recorded.dir, pass?.slug ?? 'x')))
    assert.ok(
      fail?.trial.checks[0]?.log && existsSync(join(recorded.dir, fail.trial.checks[0].log.path)),
    )
    assert.ok(pass?.trial.judgements.length, 'verdicts stay in the record')

    const scratch = readRun(p.dir).run.runId
    await runCli(p.dir, ['run', 'agent.eval'])
    const again = await runCli(p.dir, ['record', scratch])
    assert.match(again.stdout, /already recorded/)
    const none = await runCli(p.dir, ['record', scratch, '--artifacts', 'none'])
    assert.equal(none.code, 2)
    assert.match(none.stderr, /already recorded with different content.*never rewritten/)

    const q = await gitProject('record-ci', { 'evals/agent.eval.ts': agent() })
    assert.equal((await runCli(q.dir)).code, 0)
    const local = readRun(q.dir).run.runId
    assert.deepEqual(recordedRuns(q.dir), [], "record: 'ci' is the default, and this isn't CI")
    assert.equal((await runCli(q.dir, ['run'], { env: { CI: '1' } })).code, 0)
    const [ci] = recordedRuns(q.dir)
    assert.match(ci ?? '', /_ci_[0-9a-z]{4}$/)
    // By id: two runs in the same second sort by author, not start order.
    const bare = await runCli(q.dir, ['record', local, '--artifacts', 'none'])
    assert.equal(bare.code, 0, bare.stderr)
    const runs = recordedRuns(q.dir)
    assert.equal(runs.length, 2)
    assert.ok(!existsSync(join(q.dir, HISTORY, local)), 'no artifact dir with none')
  })

  test('two branches record, merge with zero conflicts, and old checkouts show old history', async () => {
    const p = await gitProject('record-merge', { 'evals/agent.eval.ts': agent() })
    sh(p.dir, 'checkout', '-q', '-b', 'a')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'record on a')
    const onA = recordedRuns(p.dir)
    const commitA = sh(p.dir, 'rev-parse', 'HEAD')

    sh(p.dir, 'checkout', '-q', 'main')
    sh(p.dir, 'checkout', '-q', '-b', 'b')
    assert.deepEqual(recordedRuns(p.dir), [], "b doesn't see a's run")
    await writeFile(join(p.dir, 'evals/second.eval.ts'), agent('second'))
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'add an eval')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'record on b')
    const onB = recordedRuns(p.dir)

    sh(p.dir, 'merge', '-q', '--no-edit', 'a')
    assert.equal(sh(p.dir, 'ls-files', '--unmerged'), '', 'zero conflicts')
    assert.equal(sh(p.dir, 'status', '--porcelain'), '')
    const merged = recordedRuns(p.dir)
    assert.deepEqual(merged, [...onA, ...onB].sort(), 'the union, in file-name order')
    const view = await historyJson(p.dir)
    assert.deepEqual(
      view.runs.map((r) => r.runId),
      merged,
    )
    assert.deepEqual(view.orphaned, [])
    const agentRow = view.rows.find((r) => r.id === 'evals/agent.eval.ts › agent')
    assert.deepEqual(agentRow?.outcomes, ['pass', 'pass', 'pass'])

    sh(p.dir, 'checkout', '-q', commitA)
    assert.deepEqual(
      (await historyJson(p.dir)).runs.map((r) => r.runId),
      onA,
      'an old commit shows the history as it was',
    )
    sh(p.dir, 'checkout', '-q', 'b')
    assert.equal((await historyJson(p.dir)).runs.length, 3, 'the cache follows the checkout')
  })

  test('runs recorded before a rebase are flagged but still compared', async () => {
    const p = await gitProject('record-rebase', { 'evals/agent.eval.ts': agent() })
    sh(p.dir, 'checkout', '-q', '-b', 'feature')
    await writeFile(join(p.dir, 'feature.txt'), 'x\n')
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'feature work')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const [before] = recordedRuns(p.dir)
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'record')

    sh(p.dir, 'checkout', '-q', 'main')
    await writeFile(join(p.dir, 'main.txt'), 'y\n')
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'main moves on')
    sh(p.dir, 'checkout', '-q', 'feature')
    sh(p.dir, 'rebase', '-q', 'main')

    const view = await historyJson(p.dir)
    assert.deepEqual(view.orphaned, [before], 'its commit was rewritten')
    const text = await runCli(p.dir, ['history'])
    assert.match(text.stdout, /1 run was recorded on commits that aren't in HEAD's history/)

    assert.equal((await runCli(p.dir)).code, 0)
    const cmp = await runCli(p.dir, ['compare', '--json'])
    assert.equal(cmp.code, 0, cmp.stderr)
    const result = JSON.parse(cmp.stdout)
    assert.equal(result.base.runId, before)
    assert.equal(result.base.inHistory, false)
    assert.equal(result.head.recorded, false)
    assert.deepEqual(
      result.rows.map((r: { status: string }) => r.status),
      ['same'],
    )
    const md = await runCli(p.dir, ['compare', '--md'])
    assert.match(
      md.stdout,
      new RegExp(
        `^base ${before} ran on a commit that isn't in HEAD's history \\(rebased or dropped\\?\\)$`,
        'm',
      ),
    )
  })

  test('runs further back than the first 20,000 commits are still in HEAD’s history', async () => {
    const p = await gitProject('record-deep', { 'evals/agent.eval.ts': agent() })
    const commit = async (name: string) => {
      await writeFile(join(p.dir, `${name}.txt`), 'x\n')
      sh(p.dir, 'add', `${name}.txt`)
      sh(p.dir, 'commit', '-q', '-m', name)
      return sh(p.dir, 'rev-parse', 'HEAD')
    }
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const second = await commit('second')
    await commit('third')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    // A later run on `second`: its base is the run on the first commit, not the one on `third`.
    sh(p.dir, 'checkout', '-q', second)
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    // The canary: a run on a commit no branch keeps is still flagged.
    await commit('dropped')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    sh(p.dir, 'checkout', '-q', 'main')
    const [onFirst, onThird, head, onDropped] = recordedRuns(p.dir)
    const parent = sh(p.dir, 'rev-parse', 'HEAD')
    let stream = ''
    for (let i = 1; i <= 20_001; i++) {
      stream += `commit refs/heads/main\ncommitter t <t@example.com> ${1_700_000_000 + i} +0000\n`
      stream += `data ${String(i).length}\n${i}\n${i === 1 ? `from ${parent}\n` : ''}\n`
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: p.dir, input: stream, env: GIT_ENV })
    sh(p.dir, 'reset', '-q', '--hard', 'main')

    assert.equal(sh(p.dir, 'rev-list', '--count', 'HEAD'), '20004')

    assert.deepEqual(
      (await historyJson(p.dir)).orphaned,
      [onDropped],
      'the others are ancestors of HEAD',
    )

    const cmp = await runCli(p.dir, ['compare', '--json', head ?? ''])
    assert.equal(cmp.code, 0, cmp.stderr)
    const result = JSON.parse(cmp.stdout)
    assert.equal(result.base.runId, onFirst, `not ${onThird}, a commit after head's`)
    assert.equal(result.base.inHistory, true)
    assert.equal(result.head.inHistory, true)
    const two = await runCli(p.dir, ['compare', '--json', onFirst ?? '', onDropped ?? ''])
    assert.deepEqual(
      [JSON.parse(two.stdout).base.inHistory, JSON.parse(two.stdout).head.inHistory],
      [true, false],
    )

    const analyze = await runCli(p.dir, ['analyze', head ?? '', '--dry-run'])
    assert.equal(analyze.code, 0, analyze.stderr)
    assert.match(analyze.stdout, new RegExp(`^digest ${head} vs ${onFirst}:`))
  })

  test('recording refuses files that look like secrets, or that changed after the run', async () => {
    const leaked = 'totally-private-value-4242'
    const p = await gitProject('record-secret', { 'evals/agent.eval.ts': agent() })
    await writeFile(
      join(p.dir, 'reeval.config.ts'),
      fakeConfig({ harness: harness(`Used ${leaked}`) }),
    )
    sh(p.dir, 'commit', '-qam', 'config')
    assert.equal((await runCli(p.dir)).code, 0)
    // A token that wasn't in the environment during the run, but is now.
    const r = await runCli(p.dir, ['record'], { env: { DEPLOY_TOKEN: leaked } })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /Refusing to record .*look like they contain a secret/s)
    assert.match(r.stderr, /\/transcript\.jsonl line \d+: the value of DEPLOY_TOKEN$/m)
    assert.doesNotMatch(r.stderr, new RegExp(leaked), 'names files, not the secret')
    assert.doesNotMatch(r.stderr, new RegExp(leaked.slice(0, 4)), 'no part of a known value')
    assert.deepEqual(recordedRuns(p.dir), [])

    const { dir, evals } = readRun(p.dir)
    await appendFile(join(dir, evals[0]?.trial.files.transcript?.path ?? ''), 'edited\n')
    const tampered = await runCli(p.dir, ['record'])
    assert.equal(tampered.code, 2)
    assert.match(tampered.stderr, /changed since the run wrote it/)

    const scan = readdirSync(join(p.dir, '.reeval/runs'), { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => readFileSync(join(f.parentPath, f.name), 'utf8'))
    assert.ok(
      scan.some((text) => text.includes(leaked)),
      'the scratch run still has it, locally',
    )
  })

  test('a dirty run saves worktree.patch, lockfile hashes and state; reeval checkout reproduces it', async () => {
    const p = await gitProject('record-state', {
      'evals/agent.eval.ts': agent(),
      'package-lock.json': '{"lockfileVersion":3}\n',
      'src/app.js': 'export const v = 1\n',
    })
    await writeFile(join(p.dir, 'src/app.js'), 'export const v = 2\n')
    await writeFile(join(p.dir, 'src/new.js'), 'export const added = true\n')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const { run, read } = readRun(p.dir, { history: HISTORY })
    assert.equal(run.git?.dirty, true)
    assert.equal(run.git?.sha, sh(p.dir, 'rev-parse', 'HEAD'), 'the commit the run executed at')
    const patch = read('worktree.patch')
    assert.match(patch, /\+export const v = 2/)
    assert.match(patch, /src\/new\.js/, 'untracked files are included')
    assert.doesNotMatch(patch, /evals\/\.history|\.reeval\//, "reeval's own output is not")
    assert.equal(run.git?.worktreePatch?.sha256, run.git?.diffHash)
    assert.deepEqual(
      run.dependencies.lockfiles.map((l) => l.path),
      ['package-lock.json'],
    )
    assert.deepEqual(run.stack.images, [])
    assert.equal(run.stack.node, process.versions.node)
    assert.deepEqual(run.stack.runtime, { name: 'node', version: process.versions.node })
    assert.deepEqual(run.stack.language, { name: 'typescript' })
    assert.ok(
      run.stack.packages.ai && run.stack.packages['@vitest/expect'] && run.stack.packages.jiti,
    )
    assert.match(run.stack.judge.version, /^[0-9a-f]{12}$/)
    assert.equal('reproducibility' in run, false)
    assert.deepEqual(run.stack.fingerprintScope.length > 0, true)
    assert.equal('fixtureHash' in (run.evals[0] ?? {}), false)
    assert.equal(sh(p.dir, 'diff', '--cached', '--name-only'), '', "the user's index is untouched")

    const shown = await runCli(p.dir, ['show', 'latest'])
    assert.match(
      shown.stdout,
      /Executed at +[0-9a-f]{12} on main, dirty \(the commit that adds this record is later\)/,
    )
    assert.match(shown.stdout, /Uncommitted +worktree\.patch, \d+ bytes/)
    assert.match(shown.stdout, /Lockfiles +package-lock\.json [0-9a-f]{12}/)
    assert.match(
      shown.stdout,
      new RegExp(`reeval +\\S+ · node ${process.versions.node} · typescript evals · `),
    )
    assert.doesNotMatch(shown.stdout, /!|not reproducible/, 'no warning when everything is saved')
    assert.match(read('summary.md'), /## State[\s\S]*\| Uncommitted \| worktree\.patch/)

    const target = join(tempDir('record-state-checkout'), 'tree')
    const co = await runCli(p.dir, ['checkout', 'latest', target])
    assert.equal(co.code, 0, co.stderr)
    assert.match(co.stdout, /applied worktree\.patch/)
    assert.equal(readFileSync(join(target, 'src/app.js'), 'utf8'), 'export const v = 2\n')
    assert.equal(readFileSync(join(target, 'src/new.js'), 'utf8'), 'export const added = true\n')
    sh(p.dir, 'worktree', 'remove', '--force', target)
  })

  test("a profile's judge is the judge the record names and fingerprints", async () => {
    const withProfile = await project('record-profile-judge', {
      'evals/agent.eval.ts': agent(),
      'reeval.config.ts': fakeConfig({
        harness: harness(),
        judge: `{ model: 'google/gemini-2.5-flash', threshold: 0.5 }`,
        extra: `profiles: {
    ci: { judge: { model: fakeJudge({ score: 0.9 }) }, defaults: { judge: { threshold: 0.8 } } },
  },`,
      }),
    })
    const r = await runCli(withProfile.dir, ['run', '--profile', 'ci'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(withProfile.dir)
    assert.equal(run.evals[0]?.attempts[0]?.judgements[0]?.threshold, 0.8, 'the profile judged')
    assert.deepEqual(
      { model: run.stack.judge.model, threshold: run.stack.judge.threshold },
      { model: 'fake', threshold: 0.8 },
    )
    assert.deepEqual(
      { model: run.config.judgeModel, threshold: run.config.threshold },
      { model: 'fake', threshold: 0.8 },
    )

    const direct = await project('record-config-judge', {
      'evals/agent.eval.ts': agent(),
      'reeval.config.ts': fakeConfig({
        harness: harness(),
        judge: '{ model: fakeJudge({ score: 0.9 }), threshold: 0.8 }',
      }),
    })
    assert.equal((await runCli(direct.dir)).code, 0)
    const same = readRun(direct.dir).run
    assert.equal(run.stack.judge.version, same.stack.judge.version)
    assert.equal(
      run.evals[0]?.cells[0]?.fingerprintParts.judge,
      same.evals[0]?.cells[0]?.fingerprintParts.judge,
      'the same judge is the same measurement, however it was chosen',
    )
  })

  test("a profile's defaults.sandbox is the sandbox the run header and the record name", async () => {
    const p = await project('record-profile-sandbox', {
      'evals/agent.eval.ts': agent(),
      'reeval.config.ts': fakeConfig({
        harness: harness(),
        extra: 'profiles: { fake: { defaults: { sandbox } } },',
      })
        .replace(
          "import { fakeSandbox } from 'reeval/sandbox'",
          "import { docker, fakeSandbox } from 'reeval/sandbox'",
        )
        .replace('  sandbox,\n', '  sandbox: docker(),\n'),
    })
    const r = await runCli(p.dir, ['run', '--profile', 'fake', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, / · harness fake · sandbox fake · /)
    const { run } = readRun(p.dir)
    assert.equal(run.evals[0]?.cells[0]?.sandbox, 'fake', 'the cell ran on the fake sandbox')
    assert.equal(run.config.sandbox, 'fake')
    assert.equal(run.profile?.defaults.sandbox, 'fake')
  })

  test("the config's judge.state is in the record and the fingerprint; its defaults change neither", async () => {
    const run = async (name: string, judge: string) => {
      const p = await project(name, {
        'evals/agent.eval.ts': agent(),
        'reeval.config.ts': fakeConfig({ harness: harness(), judge }),
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 0, r.stdout + r.stderr)
      return readRun(p.dir).run
    }
    const plain = await run('state-none', '{ model: fakeJudge({ score: 0.9 }) }')
    const defaults = await run(
      'state-defaults',
      '{ model: fakeJudge({ score: 0.9 }), state: { diff: true } }',
    )
    const narrowed = await run(
      'state-diff',
      "{ model: fakeJudge({ score: 0.9 }), state: { diff: ['src/'] } }",
    )
    const part = (r: typeof plain) => r.evals[0]?.cells[0]?.fingerprintParts.judge
    assert.equal(part(defaults), part(plain), 'the defaults are the same measurement')
    assert.equal(defaults.stack.judge.state, undefined)
    assert.notEqual(part(narrowed), part(plain), 'a narrower judge is a new measurement')
    assert.deepEqual(narrowed.stack.judge.state?.diff, ['src/'])
  })

  test("the cell's gateway is in the record, and direct leaves the fingerprint as it was", async () => {
    const run = async (name: string, gateway?: string) => {
      const p = await project(name, {
        'evals/agent.eval.ts': agent(),
        'reeval.config.ts': `import { direct, vercel } from 'reeval/gateway'
${fakeConfig({ harness: harness(), ...(gateway ? { extra: `gateway: ${gateway},` } : {}) })}`,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 0, r.stdout + r.stderr)
      return readRun(p.dir).run.evals[0]?.cells[0]
    }
    const unset = await run('gateway-unset')
    const direct = await run('gateway-direct', '[direct()]')
    assert.equal(unset?.gateway, undefined)
    assert.equal(direct?.gateway, 'direct')
    assert.equal(direct?.fingerprintParts.gateway, undefined)
    assert.equal(direct?.fingerprint, unset?.fingerprint, 'direct() is how reeval always ran')
    const vercel = await run('gateway-vercel', '[vercel(), direct()]')
    assert.equal(vercel?.gateway, 'vercel')
    assert.equal(vercel?.fingerprintParts.gateway, 'vercel')
    assert.equal(vercel?.fingerprintParts.harness, unset?.fingerprintParts.harness)
    assert.notEqual(vercel?.fingerprint, unset?.fingerprint, 'another route is another measurement')
  })

  test('a project reached through another spelling of its path records like any other', async () => {
    // A symlink here; on Windows an 8.3 short name (C:\\Users\\RUNNER~1). git reports its top
    // level canonically, so paths reeval works out against it must be spelled from the project's root.
    const p = await gitProject('record-symlink', {
      'evals/agent.eval.ts': agent(),
      'package-lock.json': '{"lockfileVersion":3}\n',
    })
    const link = join(tempDir('record-symlink-link'), 'project')
    symlinkSync(p.dir, link, 'junction')
    // Through --config: a symlinked cwd would be resolved by the OS.
    const config = ['--config', join(link, 'reeval.config.ts')]
    for (let i = 0; i < 2; i++) {
      const clean = await runCli(p.dir, ['run', '--record', ...config])
      assert.equal(clean.code, 0, clean.stdout + clean.stderr)
      const { git } = readRun(link, { history: HISTORY }).run
      assert.equal(git?.dirty, false, 'its own history is not a change')
    }
    await writeFile(join(link, 'app.js'), 'export const v = 2\n')
    assert.equal((await runCli(p.dir, ['run', '--record', ...config])).code, 0)
    const { run, read } = readRun(link, { history: HISTORY })
    assert.equal(run.git?.dirty, true)
    assert.match(read('worktree.patch'), /\+export const v = 2/)
    assert.doesNotMatch(read('worktree.patch'), /evals\/\.history/)
    assert.deepEqual(
      run.dependencies.lockfiles.map((l) => l.path),
      ['package-lock.json'],
    )
  })

  test('paths print from the current directory when the config is reached through a symlink', async () => {
    // As on macOS, where the temp dir is /var/… and the current directory /private/var/….
    const p = await gitProject('display-symlink', { 'evals/agent.eval.ts': agent() })
    const link = join(tempDir('display-symlink-link'), 'project')
    symlinkSync(p.dir, link, 'junction')
    const r = await runCli(p.dir, ['run', '--record', '--config', join(link, 'reeval.config.ts')])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, / · results \.reeval\/runs\/\S+\/summary\.md$/m)
    assert.match(r.stdout, /^recorded evals\/\.history\/\S+\.json/m)
    assert.doesNotMatch(r.stdout + r.stderr, /\.\.\//)
  })

  test('a secret in the uncommitted changes records the run without worktree.patch, and says where', async () => {
    const key = `AIza${'Q'.repeat(31)}WXYZ`
    const p = await gitProject('record-patch-secret', { 'evals/agent.eval.ts': agent() })
    await writeFile(join(p.dir, '.env.example'), `# keys\nCURSOR_API_KEY=\nGEMINI_API_KEY=${key}\n`)
    assert.equal((await runCli(p.dir)).code, 0)
    const r = await runCli(p.dir, ['record'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /^warning: left worktree\.patch out of \S+: it looks like it holds a secret\.$/m,
    )
    assert.match(
      r.stdout,
      /^ {2}worktree\.patch: \.env\.example line 3: Google API key \(AIza…WXYZ\)$/m,
    )
    assert.match(
      r.stdout,
      /uncommitted changes when the run started \(git status\), not the agents' work/,
    )
    assert.match(r.stdout, /--skip-secret-scan\.$/m)
    assert.match(
      r.stdout,
      /Nothing was committed\. Take the key out of those files, or add them to \.gitignore/,
    )
    assert.match(r.stdout, /rotate the key only if it's already been committed or pushed/)
    assert.doesNotMatch(r.stdout, /rotate it/)
    assert.match(r.stdout, /^recorded evals\/\.history\/\S+\.json/m)
    assert.doesNotMatch(r.stdout, new RegExp(key))

    const [runId] = recordedRuns(p.dir)
    const historyDir = join(p.dir, 'evals/.history')
    const record = JSON.parse(readFileSync(join(historyDir, `${runId}.json`), 'utf8'))
    assert.equal(record.git.dirty, true)
    assert.equal(record.git.worktreePatch, null)
    assert.equal(
      record.git.worktreePatchNote,
      'not kept: it looked like it held a secret (.env.example line 3: Google API key)',
    )
    assert.ok(record.git.diffHash, 'the hash of the changes is still recorded')
    const runDir = join(historyDir, runId as string)
    assert.ok(!existsSync(join(runDir, 'worktree.patch')))
    assert.match(readFileSync(join(runDir, 'summary.md'), 'utf8'), /not saved: not kept: it looked/)

    const show = await runCli(p.dir, ['show'])
    assert.match(
      show.stdout,
      /Uncommitted changes weren't saved \(not kept: it looked like it held a secret/,
    )
    const target = join(tempDir('record-patch-secret-checkout'), 'tree')
    const co = await runCli(p.dir, ['checkout', 'latest', target])
    assert.equal(co.code, 0, co.stderr)
    assert.match(
      co.stdout,
      /^checked out \w{12} into \S+, without the run's uncommitted changes: they weren't saved \(not kept: it looked like it held a secret \(\.env\.example line 3: Google API key\)\)\.$/m,
    )
    assert.ok(!existsSync(join(target, '.env.example')))
  })

  test('--skip-secret-scan keeps a worktree.patch that looks like it holds a secret', async () => {
    const p = await gitProject('record-patch-skip', { 'evals/agent.eval.ts': agent() })
    await writeFile(join(p.dir, 'config.js'), `export const key = 'AIza${'Q'.repeat(35)}'\n`)
    assert.equal((await runCli(p.dir)).code, 0)
    const r = await runCli(p.dir, ['record', '--skip-secret-scan'])
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /warning/)
    const [runId] = recordedRuns(p.dir)
    const runDir = join(p.dir, 'evals/.history', runId as string)
    assert.ok(existsSync(join(runDir, 'worktree.patch')))
  })

  test('reeval checkout stops before making a worktree when the recorded worktree.patch is gone', async () => {
    const p = await gitProject('record-patch-missing', { 'evals/agent.eval.ts': agent() })
    await writeFile(join(p.dir, 'notes.txt'), 'uncommitted\n')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const [runId] = recordedRuns(p.dir)
    const runDir = join(p.dir, 'evals/.history', runId as string)
    await rm(join(runDir, 'worktree.patch'))
    const target = join(tempDir('record-patch-missing-checkout'), 'tree')
    const co = await runCli(p.dir, ['checkout', 'latest', target])
    assert.equal(co.code, 2)
    assert.match(
      co.stderr,
      /worktree\.patch is missing, but the record says the run's uncommitted changes are in it\. Restore it from git/,
    )
    assert.ok(!existsSync(target), 'no worktree is left behind')
  })
})

describe('what a record says about comparability', () => {
  const importing = `import { evaluate, expect } from 'reeval'
import { prompt } from './helpers.ts'
evaluate('agent', async (c) => {
  await c.send(prompt)
  expect(await c.judge('Did it write hello.txt?')).toPass()
})
`
  const compareJson = async (dir: string) => {
    const r = await runCli(dir, ['compare', '--json'])
    assert.equal(r.code, 0, r.stderr)
    return JSON.parse(r.stdout) as { rows: Array<{ status: string; changes?: string[] }> }
  }

  test('an imported helper is part of the fingerprint, and reeval compare names what changed', async () => {
    const p = await gitProject('traced', {
      'evals/agent.eval.ts': importing,
      'evals/helpers.ts': "export const prompt = 'write hello.txt'\n",
      'evals/unrelated.ts': 'export const x = 1\n',
    })
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const base = readRun(p.dir, { history: HISTORY })
    const [entry] = base.run.evals
    assert.deepEqual(
      entry?.sources.map((s) => s.path),
      ['evals/agent.eval.ts', 'evals/helpers.ts'],
    )
    for (const cell of entry?.cells ?? []) {
      assert.equal(cell.fingerprint, fingerprintOf(cell.fingerprintParts))
    }

    // Twin: a file the eval doesn't import changes nothing.
    await writeFile(join(p.dir, 'evals/unrelated.ts'), 'export const x = 2\n')
    assert.equal((await runCli(p.dir)).code, 0)
    assert.equal(readRun(p.dir).run.evals[0]?.fingerprint, entry?.fingerprint)
    assert.deepEqual(
      (await compareJson(p.dir)).rows.map((r) => r.status),
      ['same'],
    )

    await writeFile(join(p.dir, 'evals/helpers.ts'), "export const prompt = 'write hello.txt!'\n")
    assert.equal((await runCli(p.dir)).code, 0)
    const [row] = (await compareJson(p.dir)).rows
    assert.deepEqual([row?.status, row?.changes], ['drift', ['evals/helpers.ts changed']])
    const text = await runCli(p.dir, ['compare'])
    assert.match(text.stdout, /^can't compare {4}agent\n {2}changed {10}evals\/helpers\.ts\n/m)

    await writeFile(join(p.dir, 'evals/helpers.ts'), "export const prompt = 'write hello.txt'\n")
    await writeFile(
      join(p.dir, 'reeval.config.ts'),
      fakeConfig({ harness: harness('Wrote it, differently') }),
    )
    assert.equal((await runCli(p.dir)).code, 0)
    const [config] = (await compareJson(p.dir)).rows
    assert.deepEqual(config?.changes, ['harness config changed'])
  })

  test('reeval compare --fail-on-regression fails on a regression and on a failing new eval; no base is no error', async () => {
    const flip = `import { evaluate, expect } from 'reeval'
evaluate('flips', async (c) => {
  await c.send('write hello.txt')
  expect(process.env.REEVAL_TEST_BREAK ?? 'ok').toBe('ok')
})
`
    const p = await gitProject('fail-on-regression', { 'evals/a.eval.ts': flip })
    const broken = { env: { REEVAL_TEST_BREAK: '1' } }
    const compareCode = async (...args: string[]) => {
      const r = await runCli(p.dir, ['compare', ...args])
      return { code: r.code, out: r.stdout + r.stderr }
    }

    // No recorded run yet: every eval is new, which isn't an error.
    assert.equal((await runCli(p.dir)).code, 0)
    const first = await compareCode()
    assert.equal(first.code, 0, first.out)
    assert.match(
      first.out,
      /^No earlier recorded run to compare \S+ with, so every eval is new\.$/m,
    )
    assert.match(first.out, /^pass {13}flips$/m)
    assert.match(first.out, /^1 new eval \(1 pass\)$/m)
    assert.equal((await compareCode('--fail-on-regression')).code, 0)
    assert.equal(JSON.parse((await compareCode('--json')).out).base, null)
    assert.equal((await runCli(p.dir, ['run'], broken)).code, 1)
    const newFailing = await compareCode('--fail-on-regression')
    assert.equal(newFailing.code, 1, newFailing.out)
    assert.match(newFailing.out, /^1 new eval \(1 fail\)$/m)
    assert.match(
      (await compareCode('--md')).out,
      /^### reeval compare: \S+\n\n```text\nNo earlier recorded run/,
    )

    // With a recorded base: pass → fail regresses.
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    assert.equal((await runCli(p.dir, ['run'], broken)).code, 1)
    assert.equal((await compareCode('--fail-on-regression')).code, 1)
    assert.equal((await compareCode()).code, 0, 'without the flag, compare exits 0')

    // A new eval that fails fails the check too; one that passes doesn't.
    await writeFile(join(p.dir, 'evals/b.eval.ts'), failing)
    assert.equal((await runCli(p.dir)).code, 1)
    const added = await compareCode('--fail-on-regression')
    assert.equal(added.code, 1, added.out)
    assert.match(added.out, /^new {14}broken\n {2}head {13}\S+ {2}fail$/m)
    await writeFile(join(p.dir, 'evals/b.eval.ts'), agent('fresh'))
    assert.equal((await runCli(p.dir)).code, 0)
    const twin = await compareCode('--fail-on-regression')
    assert.equal(twin.code, 0, twin.out)
  })

  test('reeval compare --fail-on-regression fails on a failing eval that changed (not comparable); a passing one is fine', async () => {
    const edited = (prompt: string) => `import { evaluate, expect } from 'reeval'
evaluate('edited', async (c) => {
  await c.send('${prompt}')
  expect(process.env.REEVAL_TEST_BREAK ?? 'ok').toBe('ok')
})
`
    const p = await gitProject('fail-on-drift', { 'evals/a.eval.ts': edited('write hello.txt') })
    const compareCode = async (...args: string[]) => {
      const r = await runCli(p.dir, ['compare', ...args])
      return { code: r.code, out: r.stdout + r.stderr }
    }
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)

    await writeFile(join(p.dir, 'evals/a.eval.ts'), edited('write hello.txt!'))
    assert.equal((await runCli(p.dir, ['run'], { env: { REEVAL_TEST_BREAK: '1' } })).code, 1)
    const failing = await compareCode('--fail-on-regression')
    assert.match(
      failing.out,
      /^can't compare {4}edited\n {2}changed {10}evals\/a\.eval\.ts\n {2}base {13}\S+ {2}pass\n {2}head {13}\S+ {2}fail$/m,
    )
    assert.equal(failing.code, 1, failing.out)
    assert.equal((await compareCode()).code, 0, 'without the flag, compare exits 0')

    // Canary: the same edit, passing, isn't a failure.
    assert.equal((await runCli(p.dir)).code, 0)
    const passing = await compareCode('--fail-on-regression')
    assert.match(passing.out, /^can't compare {4}edited\n(.*\n){2} {2}head {13}\S+ {2}pass$/m)
    assert.equal(passing.code, 0, passing.out)
  })

  test('reeval compare reads an eval an interrupt cancelled as cancelled, never regressed', {
    skip: noSignals,
  }, async () => {
    const p = await gitProject('compare-cancelled', {})
    const started = join(p.dir, 'slow.started')
    mkdirSync(join(p.dir, 'evals'))
    await writeFile(
      join(p.dir, 'evals/a.eval.ts'),
      `import { writeFileSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
evaluate('flips', async (c) => {
  await c.send('write hello.txt')
  expect(process.env.REEVAL_TEST_BREAK ?? 'ok', 'returns ok').toBe('ok')
})
evaluate('slow', async (c) => {
  if (process.env.REEVAL_TEST_SLOW) {
    writeFileSync(${JSON.stringify(started)}, '')
    await new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)))
  }
  expect(1, 'finished').toBe(1)
})
`,
    )
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'evals')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const compareCode = async (...args: string[]) => {
      const r = await runCli(p.dir, ['compare', ...args])
      return { code: r.code, out: r.stdout + r.stderr }
    }
    // One attempt at a time, so `flips` has finished by the time `slow` starts waiting.
    const interrupted = async (env: Record<string, string>) => {
      await rm(started, { force: true })
      let pid = 0
      const run = runCli(p.dir, ['run', '--concurrency', '1'], {
        env: { REEVAL_TEST_SLOW: '1', ...env },
        onOutput: (_, id) => {
          pid = id
          return true
        },
      })
      while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 50))
      process.kill(pid, 'SIGINT')
      const r = await run
      assert.equal(r.code, 130, r.stdout + r.stderr)
    }

    await interrupted({})
    const cancelled = await compareCode('--fail-on-regression')
    assert.match(
      cancelled.out,
      /^can't compare {4}slow\n {2}base {13}\S+ {2}pass\n {2}head {13}\S+ {2}cancelled$/m,
    )
    assert.doesNotMatch(cancelled.out, /regressed/)
    assert.match(cancelled.out, /^1 can't compare · 1 same$/m)
    assert.equal(cancelled.code, 0, cancelled.out)
    const row = JSON.parse((await compareCode('--json')).out).rows.find((r: { id: string }) =>
      r.id.endsWith('slow'),
    )
    assert.deepEqual([row.status, row.head, row.cancelled], ['drift', 'fail', ['head']])

    // Canary: a real pass → fail in the same interrupted head still regresses and fails the check.
    await interrupted({ REEVAL_TEST_BREAK: '1' })
    const regressed = await compareCode('--fail-on-regression')
    assert.match(regressed.out, /^regressed {8}flips\n(.*\n){2} {2}returns ok {7}pass → fail$/m)
    assert.match(regressed.out, /^can't compare {4}slow$/m)
    assert.match(regressed.out, /^1 regressed · 1 can't compare$/m)
    assert.equal(regressed.code, 1, regressed.out)
  })

  test("a turn's text is cut at 8 KB in the record; transcript.jsonl keeps it whole", async () => {
    const long = 'x'.repeat(20_000)
    const p = await project('turn-cap', {
      'reeval.config.ts': fakeConfig({ harness: `{ text: '${long}' }` }),
      'evals/t.eval.ts': `import { evaluate } from 'reeval'\nevaluate('long', async (c) => { await c.send('x') })\n`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const [e] = readRun(p.dir).evals
    const text = e?.trial.turns[0]?.text ?? ''
    assert.ok(text.startsWith('x'.repeat(8 * 1024)) && !text.startsWith('x'.repeat(8 * 1024 + 1)))
    assert.match(text, /\[reeval: truncated 20000 characters;/)
    assert.ok(e?.read(e.trial.files.transcript?.path ?? '').includes(long))
  })

  test('cells join environments by digest, not name; attempts and verdicts have keys', async () => {
    const p = await project('joins', {
      'reeval.config.ts': fakeConfig({ extra: 'concurrency: 1,' }),
      'evals/e.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const one = defineEnvironment('tools', { sandbox, env: { FLAVOUR: 'one' } })
const two = defineEnvironment('tools', { sandbox, env: { FLAVOUR: 'two' } })
evaluate('uses one', { environment: one, runs: 3 }, async (c) => {
  await c.send('x')
  expect(await c.judge('Is it fine?')).toPass()
})
evaluate('uses two', { environment: two }, async (c) => { await c.send('x') })
evaluate('uses none', async (c) => { await c.send('x') })
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const { run } = readRun(p.dir)
    const cell = (name: string) => run.evals.find((e) => e.name === name)?.cells[0]
    for (const name of ['uses one', 'uses two']) {
      const c = cell(name)
      const byDigest = run.environments.filter((e) => e.digest === c?.environmentDigest)
      assert.equal(byDigest.length, 1, `${name} resolves to one environment`)
      assert.equal(run.environments.filter((e) => e.name === c?.environment).length, 2)
    }
    assert.notEqual(cell('uses one')?.environmentDigest, cell('uses two')?.environmentDigest)
    assert.equal(cell('uses none')?.environment, 'fake')
    assert.ok(cell('uses none')?.environmentDigest)
    assert.notEqual(cell('uses none')?.environmentDigest, cell('uses one')?.environmentDigest)
    assert.deepEqual([cell('uses one')?.harnessKind, cell('uses one')?.model], ['fake', null])

    const attempts = run.evals.flatMap((e) => e.attempts)
    assert.deepEqual(
      attempts.map((a) => a.seq).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [1, 2, 3, 4, 5],
      'concurrency 1: one start order across the run',
    )
    const one = run.evals.find((e) => e.name === 'uses one')
    assert.deepEqual(
      one?.attempts.map((a) => a.key),
      [1, 2, 3].map((n) => `${one?.key} # fake/tools/fake#${n}`),
    )
    assert.ok(attempts.every((a) => a.startedAt && a.imageId === null))
    assert.match(one?.attempts[0]?.judgements[0]?.key ?? '', /^0:[0-9a-f]{12}$/)
    assert.equal('config' in run && 'harnesses' in run.config, false)
    assert.equal(run.runner.kind === 'local' || run.runner.pr !== undefined, true)
  })
})

describe('config discovery', () => {
  const passing = (name: string) => `import { evaluate } from 'reeval'
evaluate('${name}', async () => {})
`
  const wrongConfig = (name: string) => `import { evaluate, expect } from 'reeval'
evaluate('${name}', async () => expect('this config').toBe('never run'))
`

  test('every command run from a nested subdirectory finds the project config and acts from its directory', async () => {
    const p = await gitProject('found-upward', {
      'reeval.config.ts': fakeConfig({
        harness: `{ id: process.env.REEVAL_T_WHERE ?? 'unset', files: { 'hello.txt': 'hi\\n' }, text: 'Wrote it' }`,
      }),
      'evals/agent.eval.ts': agent(),
      // Decoys a run that resolved from the current directory would pick up.
      'src/deep/nested/evals/decoy.eval.ts': wrongConfig('decoy'),
      'src/deep/nested/marker.txt': 'here\n',
    })
    await writeFile(join(p.dir, '.env.local'), 'REEVAL_T_WHERE=root\n')
    await writeFile(join(p.dir, 'src/deep/nested/.env.local'), 'REEVAL_T_WHERE=cwd\n')
    const sub = join(p.dir, 'src/deep/nested')
    const config = '../../../reeval.config.ts'
    const ok = async (args: string[]) => {
      const r = await runCli(sub, args)
      assert.equal(r.code, 0, `reeval ${args.join(' ')}\n${r.stdout}${r.stderr}`)
      return r
    }

    const plan = await ok(['run', '--dry-run'])
    assert.match(
      plan.stdout,
      /^plan {2}(?:run \S+ · )?config \.\.\/\.\.\/\.\.\/reeval\.config\.ts · 1 eval · /m,
    )
    assert.doesNotMatch(plan.stdout, /decoy/)

    const run = await ok(['run', '-v'])
    assert.match(
      run.stdout,
      /plan +(?:run \S+ · )?config \.\.\/\.\.\/\.\.\/reeval\.config\.ts · no profile · /,
    )
    const first = readRun(p.dir).run
    assert.deepEqual(
      first.evals.flatMap((e) => e.attempts.map((a) => `${e.id} ${a.id}`)),
      ['evals/agent.eval.ts › agent root/fake/fake#1'],
      "the config's .env.local, not the current directory's",
    )

    assert.match((await ok(['record'])).stdout, /^recorded \.\.\/\.\.\/\.\.\/evals\/\.history\//)
    assert.deepEqual(recordedRuns(p.dir), [first.runId])
    await ok(['run', '--record'])
    assert.equal(recordedRuns(p.dir).length, 2)
    const history = JSON.parse((await ok(['history', '--json'])).stdout)
    assert.deepEqual(
      history.rows.map((r: { id: string }) => r.id),
      ['evals/agent.eval.ts › agent'],
    )
    assert.equal(JSON.parse((await ok(['show', 'latest', '--json'])).stdout).kind, 'reeval-run')
    assert.match((await ok(['compare'])).stdout, /same/i)
    assert.deepEqual(JSON.parse((await ok(['query', 'failing_attempts', '--json'])).stdout), [])
    assert.ok(existsSync(join(p.dir, '.reeval/history.db')))
    await ok(['analyze', '--context'])
    assert.match((await ok(['studio', 'build'])).stdout, /built \.\.\/\.\.\/\.\.\/studio-dist\//)
    assert.match(
      (await ok(['image', 'build', '--dry-run'])).stdout,
      /No eval runs in a Docker sandbox/,
      "the config's fake sandbox, not the default docker()",
    )
    assert.match((await ok(['clean'])).stdout, / from \.\.\/\.\.\/\.\.\/\.reeval\/debug$/m)

    assert.deepEqual(readdirSync(sub).sort(), ['.env.local', 'evals', 'marker.txt'])
    assert.equal((await ok(['run', '--dry-run', '--config', config])).code, 0)
  })

  test("a nested project's own config wins over the parent's, and --config wins over both", async () => {
    const p = await project('nearest-wins', {
      'reeval.config.ts': fakeConfig(),
      'evals/parent.eval.ts': wrongConfig('parent'),
      'packages/app/reeval.config.mjs': fakeConfig(),
      'packages/app/evals/app.eval.ts': passing('app'),
      'packages/app/src/lib/index.ts': '',
    })
    const app = join(p.dir, 'packages/app')
    const lib = join(app, 'src/lib')

    const nested = await runCli(lib)
    assert.equal(nested.code, 0, nested.stdout + nested.stderr)
    assert.deepEqual(
      readRun(app).run.evals.map((e) => e.id),
      ['evals/app.eval.ts › app'],
    )
    assert.equal(existsSync(join(p.dir, '.reeval')), false, "nothing under the parent's config")

    // Twin: the parent's config, found from its own tree or named with --config, runs its eval.
    const parent = await runCli(join(p.dir, 'evals'))
    assert.equal(parent.code, 1, parent.stdout + parent.stderr)
    assert.match(parent.stdout, /^fail {13}parent$/m)
    const named = await runCli(lib, ['run', '--config', '../../../../reeval.config.ts'])
    assert.equal(named.code, 1, named.stdout + named.stderr)
    assert.deepEqual(
      readRun(p.dir).run.evals.map((e) => e.id),
      ['evals/parent.eval.ts › parent'],
    )
  })
})

describe('records from before a field existed', () => {
  const OLD = 'fixtures/records/before-100'
  const oldRun = '20260927T151935Z_facb81b_cursor-agent_07sv'
  const raw = (): RunRecord =>
    JSON.parse(readFileSync(join(testDir, OLD, HISTORY, `${oldRun}.json`), 'utf8'))

  test('the fixture predates plan.sandboxWarnings, harnesses[].resolvedModels and evals[].todo', () => {
    const r = raw()
    assert.equal('sandboxWarnings' in r.plan, false)
    assert.equal(
      r.stack.harnesses.some((h) => 'resolvedModels' in h),
      false,
    )
    assert.equal(
      r.evals.some((e) => 'todo' in e),
      false,
    )
  })

  test('plan.sandboxWarnings: a record without it reads as none, and summary.md renders', () => {
    const r = raw()
    assert.deepEqual(readableRecord(r).plan.sandboxWarnings, [])
    assert.doesNotMatch(renderSummary(readableRecord(raw()), { hint: true }), /running as root/)
  })

  test('stack.harnesses[].effort: a record without it reads as unset, and Fast is not served effort', () => {
    const r = readableRecord(raw())
    assert.deepEqual(
      r.stack.harnesses.map((h) => [h.effort, h.resolvedEffort]),
      [[null, []]],
    )
    assert.deepEqual(
      r.evals[0]?.cells.map((c) => c.effort),
      r.evals[0]?.cells.map(() => null),
    )
    assert.deepEqual(
      r.evals[0]?.attempts.map((a) => [a.effort, a.servedEffort]),
      r.evals[0]?.attempts.map(() => [null, null]),
    )
  })

  test('stack.harnesses[].resolvedModels: a record without it reads as none, and the harness label renders', () => {
    const r = readableRecord(raw())
    assert.deepEqual(
      r.stack.harnesses.map((h) => h.resolvedModels),
      [[]],
    )
    assert.equal(
      harnessLabel(r.stack.harnesses[0] as RunRecord['stack']['harnesses'][number]),
      'fake',
    )
  })

  test('stack.runtime and stack.language: a record without them ran on Node, and names no language', () => {
    const r = readableRecord(raw())
    assert.equal('runtime' in r.stack || 'language' in r.stack, false)
    assert.equal(runtimeLabel(r.stack), `node ${r.stack.node}`)
    assert.equal(languageLabel(r.stack), null)
    assert.match(
      renderSummary(r, { hint: true }),
      new RegExp(`\\| reeval \\| \\S+ · node ${r.stack.node} · \\w+/`),
    )
  })

  test('the runtime and language labels', () => {
    const bun = { node: '26.3.0', runtime: { name: 'bun', version: '1.4.2' } }
    assert.equal(runtimeLabel(bun), 'bun 1.4.2 (node 26.3.0)')
    assert.equal(
      runtimeLabel({ node: '22.14.0', runtime: { name: 'node', version: '22.14.0' } }),
      'node 22.14.0',
    )
    assert.equal(languageLabel({ language: { name: 'typescript' } }), 'typescript evals')
    assert.equal(
      languageLabel({ language: { name: 'dart', version: '3.13.5' } }),
      'dart 3.13.5 evals',
    )
  })

  test('evals[].todo: a record without it reads as not todo, and summary.md renders', () => {
    const r = readableRecord(raw())
    assert.deepEqual(
      r.evals.map((e) => e.todo),
      [false, false],
    )
    assert.match(renderSummary(r, { hint: true }), /^pass {13}writes greet\.js$/m)
  })

  test('a newer record keeps what it has', () => {
    const r = raw()
    r.plan.sandboxWarnings = [
      { kind: 'root', level: 'config', where: 'reeval.config.ts', file: null, message: 'm' },
    ]
    r.evals[1] = { ...(r.evals[1] as RunRecord['evals'][number]), todo: true }
    const read = readableRecord(r)
    assert.equal(read.plan.sandboxWarnings.length, 1)
    assert.equal(read.evals[1]?.todo, true)
  })

  test('reeval show, show --md, history, query and compare read it next to a new run', async () => {
    const p = await fixture(OLD)
    const ok = async (args: string[]) => {
      const r = await runCli(p.dir, args)
      assert.equal(r.code, 0, `reeval ${args.join(' ')}\n${r.stdout}${r.stderr}`)
      return r.stdout
    }
    assert.match(await ok(['show', oldRun]), /writes greet\.js/)
    assert.match(await ok(['show', oldRun, '--md']), /# reeval run 20260927T151935Z/)
    assert.match(await ok(['show', oldRun, '--json']), /"sandboxWarnings": \[\]/)
    await ok(['run', '--record', '--ui', 'plain'])
    const runs = recordedRuns(p.dir)
    assert.equal(runs.length, 2)
    assert.match(await ok(['history']), /writes greet\.js/)
    assert.match(await ok(['query', 'select count(*) as n from evals']), /^n\n4$/m)
    assert.match(await ok(['query', 'eval_trend']), /writes greet\.js/)
    assert.match(
      await ok(['compare', oldRun, runs[1] as string]),
      /^(\d+ (regressed|fixed|can't compare|infra error|new|removed|same)( · )?)+$/m,
    )
    await ok(['studio', 'build', '--out', join(p.dir, 'site')])
  })
})

describe('records from a newer reeval', () => {
  const OLD = 'fixtures/records/before-100'
  const oldRun = '20260927T151935Z_facb81b_cursor-agent_07sv'
  const newRun = '20270101T000000Z_facb81b_cursor-agent_zz01'

  /** Writes a copy of the old run as `newRun`, changed by `edit`, with its artifacts. */
  async function future(dir: string, edit: (r: Record<string, unknown>) => void) {
    const history = join(dir, HISTORY)
    const r = JSON.parse(readFileSync(join(history, `${oldRun}.json`), 'utf8'))
    r.runId = newRun
    edit(r)
    await writeFile(join(history, `${newRun}.json`), JSON.stringify(r, null, 2))
    execFileSync('cp', ['-R', join(history, oldRun), join(history, newRun)])
  }

  test('a newer schemaVersion: reeval show says to upgrade reeval, and the other readers skip it with a warning', async () => {
    const p = await fixture(OLD)
    await future(p.dir, (r) => {
      r.schemaVersion = 2
    })
    const upgrade =
      /written by a newer reeval \(schemaVersion 2; this reeval reads up to 1\)\. Upgrade reeval to read it\./
    const shown = await runCli(p.dir, ['show', newRun])
    assert.notEqual(shown.code, 0, shown.stdout + shown.stderr)
    assert.match(shown.stderr, upgrade)
    for (const args of [
      ['history'],
      ['query', 'select count(*) as n from runs'],
      ['studio', 'build', '--out', join(p.dir, 'site')],
    ]) {
      const r = await runCli(p.dir, args)
      assert.equal(r.code, 0, `reeval ${args.join(' ')}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, new RegExp(`skipped ${HISTORY}/${newRun}\\.json: ${upgrade.source}`))
      assert.doesNotMatch(r.stderr, /Restore it from git/)
    }
    assert.match(
      (await runCli(p.dir, ['query', 'select count(*) as n from runs'])).stdout,
      /^n\n1$/m,
    )
    const compared = await runCli(p.dir, ['compare', oldRun, newRun])
    assert.notEqual(compared.code, 0)
    assert.match(compared.stderr, upgrade)
  })

  test('fields, values and transcript events a newer reeval added are ignored by every reader', async () => {
    const p = await fixture(OLD)
    const schema = JSON.parse(
      readFileSync(join(testDir, '../schema/run-record.schema.json'), 'utf8'),
    )
    await future(p.dir, (r) => {
      withUnknownFields(schema, r, () => ({ by: 'a newer reeval', list: [1] }))
      const record = r as unknown as RunRecord
      record.status = 'paused' as RunRecord['status']
      const attempt = record.evals[0]?.attempts[0] as RunRecord['evals'][number]['attempts'][number]
      attempt.outcome = 'cancelled' as typeof attempt.outcome
      attempt.error = { kind: 'quota' as never, message: 'a kind this reeval does not know' }
      attempt.turns[0] = {
        ...(attempt.turns[0] as (typeof attempt.turns)[number]),
        status: 'paused' as never,
      }
    })
    const transcripts = execFileSync(
      'find',
      [join(p.dir, HISTORY, newRun), '-name', 'transcript.jsonl'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
    for (const t of transcripts) {
      await appendFile(
        t,
        `${JSON.stringify({ turn: 1, ts: '2027-01-01T00:00:00.000Z', atMs: 1, type: 'hologram', frames: 3 })}\n`,
      )
    }
    for (const args of [
      ['show', newRun],
      ['show', newRun, '--json'],
      ['show', newRun, '--md'],
      ['history'],
      ['history', '--json'],
      ['query', 'eval_trend'],
      ['query', 'select count(*) as n from tool_calls'],
      ['compare', oldRun, newRun],
      ['studio', 'build', '--out', join(p.dir, 'site')],
    ]) {
      const r = await runCli(p.dir, args)
      assert.ok(
        r.code === 0 || (args[0] === 'compare' && r.code === 1),
        `reeval ${args.join(' ')}\n${r.stdout}${r.stderr}`,
      )
      assert.doesNotMatch(
        r.stderr,
        /TypeError|Cannot read|undefined is not|skipped/,
        `reeval ${args.join(' ')}\n${r.stderr}`,
      )
    }
  })
})

describe('caches another reeval wrote', () => {
  test('.reeval/history-cache.json from another reeval version is rebuilt, even at the same mtime', async () => {
    const p = await fixture('fixtures/records/before-100')
    assert.equal((await runCli(p.dir, ['history'])).code, 0)
    const file = join(p.dir, '.reeval/history-cache.json')
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    for (const hit of Object.values(cache.files) as Array<{ entry: { author: string } }>) {
      hit.entry.author = 'from-a-stale-cache'
    }
    await writeFile(file, JSON.stringify(cache))
    assert.match((await runCli(p.dir, ['history', '--json'])).stdout, /from-a-stale-cache/)
    // npm installs every file with the same mtime, so only the version tells two releases apart.
    cache.build = cache.build.replace(/^[^:]+:/, '0.0.0-older:')
    await writeFile(file, JSON.stringify(cache))
    const r = await runCli(p.dir, ['history', '--json'])
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /from-a-stale-cache/)
  })
})
