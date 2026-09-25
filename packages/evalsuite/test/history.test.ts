import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fingerprintOf } from '../src/history/assemble.ts'
import type { RunRecord } from '../src/history/types.ts'
import { baseEnv, fakeConfig, project, readRun, recordedRuns, runCli, tempDir } from './helpers.ts'

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
const agent = (name = 'agent') => `import { evaluate, expect } from 'evalsuite'
evaluate('${name}', async (t) => {
  await t.send('write hello.txt')
  expect(await t.judge('Did it write hello.txt?')).toPass()
})
`
const failing = `import { evaluate, expect } from 'evalsuite'
evaluate('broken', async (t) => {
  await t.send('write hello.txt')
  await expect(t.exec('exit 4')).toSucceed()
})
`
const harness = (text = 'Wrote it') => `{ files: { 'hello.txt': 'hi\\n' }, text: '${text}' }`

/** An ES project that is its own committed git repo, with a known author. */
async function gitProject(name: string, files: Record<string, string>, extra = '') {
  const p = await project(name, {
    '.gitignore': '.es/\nnode_modules/\nsandboxes/\n',
    'es.config.ts': fakeConfig({ harness: harness(), extra }),
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
  test('es run writes scratch; es record promotes it next to the evals', async () => {
    const p = await gitProject('record-basic', { 'evals/agent.es.ts': agent() })
    assert.equal((await runCli(p.dir)).code, 0)
    assert.deepEqual(recordedRuns(p.dir), [], 'nothing recorded without --record')
    const { run } = readRun(p.dir)
    assert.match(run.runId, /^\d{8}T\d{6}Z_[0-9a-f]{7}_test-author_[0-9a-z]{4}$/)
    assert.equal(run.git?.sha.slice(0, 7), run.runId.split('_')[1])

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
      /### ✓ evals\/agent\.es\.ts › agent/,
      'passes get detail',
    )
    assert.match(recorded.read('summary.md'), /Last message:\n\n> Wrote it/)
    const [input] = JSON.parse(recorded.read(e.trial.files.judgeInput?.path ?? ''))
    assert.deepEqual(input.state.diff.$ref, 'diff.patch', 'the judge input points at diff.patch')
    assert.equal(sh(p.dir, 'status', '--porcelain'), '?? evals/.history/', 'plain files for git')

    assert.match((await runCli(p.dir, ['record', run.runId])).stdout, /already recorded/)

    // The history folder and .es/ never make the next run dirty.
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    assert.equal(readRun(p.dir).run.git?.dirty, false)
    assert.equal(recordedRuns(p.dir).length, 2)

    const shown = await runCli(p.dir, ['show', 'latest', '--json'])
    assert.equal((JSON.parse(shown.stdout) as RunRecord).kind, 'es-run')
    assert.match((await runCli(p.dir, ['show', run.runId, '--md'])).stdout, /^# ES run /)
    assert.match(
      (await runCli(p.dir, ['history'])).stdout,
      /✓✓ +2\/2 +evals\/agent\.es\.ts › agent/,
    )
  })

  test('artifact levels, and config.record modes', async () => {
    const p = await gitProject(
      'record-levels',
      { 'evals/agent.es.ts': agent(), 'evals/broken.es.ts': failing },
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
    await runCli(p.dir, ['run', 'agent.es'])
    const again = await runCli(p.dir, ['record', scratch])
    assert.match(again.stdout, /already recorded/)
    const none = await runCli(p.dir, ['record', scratch, '--artifacts', 'none'])
    assert.equal(none.code, 2)
    assert.match(none.stderr, /already recorded with different content.*never rewritten/)

    const q = await gitProject('record-ci', { 'evals/agent.es.ts': agent() })
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
    const p = await gitProject('record-merge', { 'evals/agent.es.ts': agent() })
    sh(p.dir, 'checkout', '-q', '-b', 'a')
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'record on a')
    const onA = recordedRuns(p.dir)
    const commitA = sh(p.dir, 'rev-parse', 'HEAD')

    sh(p.dir, 'checkout', '-q', 'main')
    sh(p.dir, 'checkout', '-q', '-b', 'b')
    assert.deepEqual(recordedRuns(p.dir), [], "b doesn't see a's run")
    await writeFile(join(p.dir, 'evals/second.es.ts'), agent('second'))
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
    const agentRow = view.rows.find((r) => r.id === 'evals/agent.es.ts › agent')
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
    const p = await gitProject('record-rebase', { 'evals/agent.es.ts': agent() })
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
    assert.match(md.stdout, /commit not in HEAD's history/)
  })

  test('recording refuses files that look like secrets, or that changed after the run', async () => {
    const leaked = 'totally-private-value-4242'
    const p = await gitProject('record-secret', { 'evals/agent.es.ts': agent() })
    await writeFile(join(p.dir, 'es.config.ts'), fakeConfig({ harness: harness(`Used ${leaked}`) }))
    sh(p.dir, 'commit', '-qam', 'config')
    assert.equal((await runCli(p.dir)).code, 0)
    // A token that wasn't in the environment during the run, but is now.
    const r = await runCli(p.dir, ['record'], { env: { DEPLOY_TOKEN: leaked } })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /Refusing to record .*look like they contain a secret/s)
    assert.match(r.stderr, /\/transcript\.jsonl/)
    assert.doesNotMatch(r.stderr, new RegExp(leaked), 'names files, not the secret')
    assert.deepEqual(recordedRuns(p.dir), [])

    const { dir, evals } = readRun(p.dir)
    await appendFile(join(dir, evals[0]?.trial.files.transcript?.path ?? ''), 'edited\n')
    const tampered = await runCli(p.dir, ['record'])
    assert.equal(tampered.code, 2)
    assert.match(tampered.stderr, /changed since the run wrote it/)

    const scan = readdirSync(join(p.dir, '.es/runs'), { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => readFileSync(join(f.parentPath, f.name), 'utf8'))
    assert.ok(
      scan.some((text) => text.includes(leaked)),
      'the scratch run still has it, locally',
    )
  })

  test('a dirty run saves worktree.patch, lockfile hashes and state; es checkout reproduces it', async () => {
    const p = await gitProject('record-state', {
      'evals/agent.es.ts': agent(),
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
    assert.doesNotMatch(patch, /evals\/\.history|\.es\//, "ES's own output is not")
    assert.equal(run.git?.worktreePatch?.sha256, run.git?.diffHash)
    assert.deepEqual(
      run.dependencies.lockfiles.map((l) => l.path),
      ['package-lock.json'],
    )
    assert.deepEqual(run.stack.images, [])
    assert.ok(run.stack.packages.ai && run.stack.packages.vitest)
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

  test('a secret in the uncommitted changes stops the record', async () => {
    const p = await gitProject('record-patch-secret', { 'evals/agent.es.ts': agent() })
    await writeFile(join(p.dir, 'config.js'), `export const key = 'AIza${'Q'.repeat(35)}'\n`)
    assert.equal((await runCli(p.dir)).code, 0)
    const r = await runCli(p.dir, ['record'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /\/worktree\.patch/)
    assert.deepEqual(recordedRuns(p.dir), [])
  })
})

describe('what a record says about comparability', () => {
  const importing = `import { evaluate, expect } from 'evalsuite'
import { prompt } from './helpers.ts'
evaluate('agent', async (t) => {
  await t.send(prompt)
  expect(await t.judge('Did it write hello.txt?')).toPass()
})
`
  const compareJson = async (dir: string) => {
    const r = await runCli(dir, ['compare', '--json'])
    assert.equal(r.code, 0, r.stderr)
    return JSON.parse(r.stdout) as { rows: Array<{ status: string; changes?: string[] }> }
  }

  test('an imported helper is part of the fingerprint, and es compare names what changed', async () => {
    const p = await gitProject('traced', {
      'evals/agent.es.ts': importing,
      'evals/helpers.ts': "export const prompt = 'write hello.txt'\n",
      'evals/unrelated.ts': 'export const x = 1\n',
    })
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    const base = readRun(p.dir, { history: HISTORY })
    const [entry] = base.run.evals
    assert.deepEqual(
      entry?.sources.map((s) => s.path),
      ['evals/agent.es.ts', 'evals/helpers.ts'],
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
    assert.match(
      text.stdout,
      /changed \(not comparable\) +evals\/agent\.es\.ts › agent: evals\/helpers\.ts changed/,
    )

    await writeFile(join(p.dir, 'evals/helpers.ts'), "export const prompt = 'write hello.txt'\n")
    await writeFile(
      join(p.dir, 'es.config.ts'),
      fakeConfig({ harness: harness('Wrote it, differently') }),
    )
    assert.equal((await runCli(p.dir)).code, 0)
    const [config] = (await compareJson(p.dir)).rows
    assert.deepEqual(config?.changes, ['harness config changed'])
  })

  test("a turn's text is cut at 8 KB in the record; transcript.jsonl keeps it whole", async () => {
    const long = 'x'.repeat(20_000)
    const p = await project('turn-cap', {
      'es.config.ts': fakeConfig({ harness: `{ text: '${long}' }` }),
      'evals/t.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('long', async (t) => { await t.send('x') })\n`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const [e] = readRun(p.dir).evals
    const text = e?.trial.turns[0]?.text ?? ''
    assert.ok(text.startsWith('x'.repeat(8 * 1024)) && !text.startsWith('x'.repeat(8 * 1024 + 1)))
    assert.match(text, /\[es: truncated 20000 characters;/)
    assert.ok(e?.read(e.trial.files.transcript?.path ?? '').includes(long))
  })

  test('cells join environments by digest, not name; attempts and verdicts have keys', async () => {
    const p = await project('joins', {
      'es.config.ts': fakeConfig({ extra: 'concurrency: 1,' }),
      'evals/e.es.ts': `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const one = defineEnvironment('tools', { env: { FLAVOUR: 'one' } })
const two = defineEnvironment('tools', { env: { FLAVOUR: 'two' } })
evaluate('uses one', { environment: one, runs: 3 }, async (t) => {
  await t.send('x')
  expect(await t.judge('Is it fine?')).toPass()
})
evaluate('uses two', { environment: two }, async (t) => { await t.send('x') })
evaluate('uses none', async (t) => { await t.send('x') })
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const { run } = readRun(p.dir)
    const cell = (name: string) => run.evals.find((e) => e.name === name)?.cells[0]
    for (const name of ['uses one', 'uses two']) {
      const c = cell(name)
      const byDigest = run.environments.filter((e) => e.digest === c?.environmentDigest)
      assert.equal(byDigest.length, 1, `${name} resolves to one environment`)
      // Twin: the old join by name is ambiguous here.
      assert.equal(run.environments.filter((e) => e.name === c?.environment).length, 2)
    }
    assert.notEqual(cell('uses one')?.environmentDigest, cell('uses two')?.environmentDigest)
    assert.equal(cell('uses none')?.environmentDigest, null)
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
