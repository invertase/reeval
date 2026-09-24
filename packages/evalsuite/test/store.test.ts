import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newRunId, runDir } from '../src/ids.ts'
import { buildIndex, deriveStore, encodeJson, parseIndex } from '../src/record/index-file.ts'
import type { RunRecord } from '../src/record/types.ts'
import { countSecrets, redactSecrets, stripCredentials } from '../src/redact.ts'
import { gitBranchStore } from '../src/store/git.ts'
import { localStore } from '../src/store/local.ts'
import { PublishError, publishRuns } from '../src/store/sync.ts'
import { ImmutableFileError, type StoreReader } from '../src/store/types.ts'
import { fakeConfig, pkgRoot, project, readRun, runCli } from './helpers.ts'

const tmp = join(pkgRoot, 'test/.tmp')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

/** A bare repo on disk standing in for GitHub, with partial clone enabled like GitHub has. */
async function bareRemote(name: string): Promise<string> {
  const dir = join(tmp, `${name}.git`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  sh(dir, 'init', '--bare', '-q')
  sh(dir, 'config', 'uploadpack.allowFilter', 'true')
  sh(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  return dir
}

const math = (value: number) =>
  `import { evaluate, expect } from 'evalsuite'\nevaluate('math', async () => expect(1).toBe(${value}))\n`

const agent = `import { evaluate, expect } from 'evalsuite'
evaluate('agent', async (t) => {
  await t.send('write hello.txt')
  expect(await t.judge('Did it write hello.txt?')).toPass()
})
`

/** An ES project that is its own committed git repo. */
async function gitProject(name: string, files: Record<string, string>) {
  const p = await project(name, {
    '.gitignore': '.es/\nnode_modules/\nsandboxes/\n',
    'es.config.ts': fakeConfig({
      harness: `{ files: { 'hello.txt': 'hi\\n' }, text: 'Wrote it' }`,
    }),
    ...files,
  })
  sh(p.dir, 'init', '-q', '-b', 'main')
  sh(p.dir, 'add', '-A')
  sh(p.dir, 'commit', '-q', '-m', 'init')
  return p
}

const remoteFiles = (remote: string, branch = 'es-results') =>
  sh(remote, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean)

describe('local store', () => {
  test('files are create-only, and the index is derived and deterministic', async () => {
    const dir = join(tmp, 'local-store')
    await rm(dir, { recursive: true, force: true })
    const store = localStore({ root: dir })
    const runA = fakeRun(newRunId(new Date('2026-09-01T10:00:00Z')))
    const runB = fakeRun(newRunId(new Date('2026-10-02T10:00:00Z')))
    const first = await store.commit({ files: runFiles(runA), derive: deriveStore, message: 'a' })
    assert.equal(first.created.length, 2)
    assert.equal(first.changed, true)

    const again = await store.commit({ files: runFiles(runA), derive: deriveStore, message: 'a' })
    assert.deepEqual(again.created, [])
    assert.equal(again.changed, false, 'identical bytes are a no-op')

    const tampered = new Map([[`${runDir(runA.runId)}/summary.md`, Buffer.from('rewritten')]])
    await assert.rejects(
      store.commit({ files: tampered, derive: deriveStore, message: 'x' }),
      ImmutableFileError,
    )

    await store.commit({ files: runFiles(runB), derive: deriveStore, message: 'b' })
    assert.ok(existsSync(join(dir, '.es/runs/2026/10', runB.runId, 'run.json')), 'sharded by month')
    const incremental = parseIndex(await store.get('index.json'))
    const rebuilt = await buildIndex(store, null)
    assert.deepEqual(incremental, rebuilt)
    assert.deepEqual(
      rebuilt.runs.map((r) => r.runId),
      [runA.runId, runB.runId],
    )
    assert.match(readFileSync(join(dir, '.es/README.md'), 'utf8'), /# ES results/)
  })

  test('newer schemas are rejected and stale indexes are rebuilt', async () => {
    const dir = join(tmp, 'local-schema')
    await rm(dir, { recursive: true, force: true })
    const store = localStore({ root: dir })
    const run = fakeRun(newRunId())
    await store.commit({ files: runFiles(run), derive: deriveStore, message: 'a' })
    await writeFile(join(dir, '.es/index.json'), '{"kind":"es-index","schemaVersion":2,"runs":[]}')
    const future = fakeRun(newRunId())
    const files = runFiles({ ...future, schemaVersion: 4 as 3 })
    await store.commit({ files, derive: deriveStore, message: 'b' })
    const index = parseIndex(await store.get('index.json'))
    assert.deepEqual(
      index?.runs.map((r) => r.runId),
      [run.runId],
      'the v4 record is skipped, the v2 index replaced',
    )
  })
})

describe('redaction', () => {
  test('token shapes are masked and credentials stripped from URLs', () => {
    const google = `AIza${'Q'.repeat(35)}`
    const github = `ghp_${'a'.repeat(36)}`
    const text = `key=${google} token ${github} fine`
    assert.equal(redactSecrets(text, {}), 'key=[REDACTED] token [REDACTED] fine')
    assert.equal(countSecrets(text, {}), 2)
    assert.equal(
      stripCredentials('https://x-access-token:abc@github.com/o/r.git'),
      'https://github.com/o/r.git',
    )
    assert.equal(stripCredentials('git@github.com:o/r.git'), 'git@github.com:o/r.git')
  })
})

describe('git-branch store against a bare remote', () => {
  test('publish, re-publish, pull records, then pull everything', async () => {
    const remote = await bareRemote('remote-basic')
    // big.txt makes diff.patch bigger than the partial-fetch filter, so readers fetch it lazily.
    const a = await gitProject('publisher-a', {
      'evals/agent.es.ts': agent,
      'es.config.ts': fakeConfig({
        harness: `{ files: { 'hello.txt': 'hi\\n', 'big.txt': '${'x'.repeat(300_000)}' }, text: 'Wrote it' }`,
      }),
    })
    assert.equal((await runCli(a.dir)).code, 0)
    const { run } = readRun(a.dir)
    assert.equal(run.git?.dirty, false, 'the run output under .es/ does not dirty the tree')
    assert.equal(run.git?.branch, 'main')

    const published = await runCli(a.dir, ['publish', '--remote', remote])
    assert.equal(published.code, 0, published.stderr)
    assert.match(published.stdout, new RegExp(`published run ${run.runId} \\(\\d+ files\\)`))
    const files = remoteFiles(remote)
    assert.ok(files.includes('index.json') && files.includes('README.md'))
    assert.ok(files.includes(`${runDir(run.runId)}/run.json`))
    assert.ok(files.some((f) => f.endsWith('/transcript.jsonl')))
    assert.equal(sh(remote, 'rev-list', '--count', 'es-results'), '1')
    assert.equal(sh(remote, 'rev-list', '--max-parents=0', 'es-results').split('\n').length, 1)

    const again = await runCli(a.dir, ['publish', run.runId, '--remote', remote])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /already published/)
    assert.equal(sh(remote, 'rev-list', '--count', 'es-results'), '1', 'no empty commit')

    const b = await gitProject('reader-b', {})
    const pulled = await runCli(b.dir, ['pull', '--remote', remote])
    assert.equal(pulled.code, 0, pulled.stderr)
    assert.match(pulled.stdout, /pulled 1 run \(\d+ files, records only/)
    const local = readRun(b.dir)
    assert.equal(local.run.runId, run.runId)
    assert.ok(!existsSync(join(local.dir, local.evals[0]?.trial.files.transcript?.path ?? 'x')))
    const cacheRoot = join(b.dir, '.es/cache/git')
    const [cache] = readdirSync(cacheRoot)
    const missing = () =>
      sh(join(cacheRoot, cache ?? ''), 'rev-list', '--objects', '--missing=print', 'refs/es/tip')
        .split('\n')
        .filter((l) => l.startsWith('?'))
    // diff.patch and judge-input.json (which holds the same diff) stay on the remote for now.
    assert.equal(missing().length, 2)

    const full = await runCli(b.dir, ['pull', '--full', '--run', run.runId, '--remote', remote])
    assert.equal(full.code, 0, full.stderr)
    const transcript = local.evals[0]?.trial.files.transcript?.path ?? ''
    assert.ok(existsSync(join(local.dir, transcript)))
    assert.equal(
      readFileSync(join(local.dir, transcript), 'utf8'),
      readFileSync(join(readRun(a.dir).dir, transcript), 'utf8'),
    )
    const diff = local.evals[0]?.trial.files.diff
    assert.ok(diff && diff.bytes > 128 * 1024)
    assert.equal(readFileSync(join(local.dir, diff.path), 'utf8').length, diff.bytes)
    assert.deepEqual(missing(), [], 'fetched on demand')
    assert.match((await runCli(b.dir, ['pull', '--remote', remote])).stdout, /up to date/)

    const shown = await runCli(b.dir, ['show', 'latest', '--md'])
    assert.equal(shown.code, 0, shown.stderr)
    assert.match(shown.stdout, new RegExp(`# ES run ${run.runId}`))
  })

  test('dirty runs are refused unless allowed', async () => {
    const remote = await bareRemote('remote-dirty')
    const p = await gitProject('publisher-dirty', { 'evals/math.es.ts': math(1) })
    await writeFile(join(p.dir, 'uncommitted.txt'), 'wip\n')
    assert.equal((await runCli(p.dir)).code, 0)
    assert.equal(readRun(p.dir).run.git?.dirty, true)
    const refused = await runCli(p.dir, ['publish', '--remote', remote])
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /dirty working tree.*--allow-dirty/)
    assert.equal(sh(remote, 'branch', '--list'), '', 'nothing pushed')
    const allowed = await runCli(p.dir, ['publish', '--remote', remote, '--allow-dirty'])
    assert.equal(allowed.code, 0, allowed.stderr)
  })

  test('a file that looks like a secret stops the publish', async () => {
    const remote = await bareRemote('remote-secret')
    const dir = join(tmp, 'publisher-secret')
    await rm(dir, { recursive: true, force: true })
    const local = localStore({ root: dir })
    const run = fakeRun(newRunId())
    const files = runFiles(run)
    files.set(
      `${runDir(run.runId)}/evals/x/1/final.md`,
      Buffer.from(`leaked AIza${'Z'.repeat(35)}`),
    )
    await local.commit({ files, derive: deriveStore, message: 'seed' })
    const target = gitBranchStore({ remote, root: dir })
    await assert.rejects(publishRuns(local, target, [run.runId]), (error: Error) => {
      assert.ok(error instanceof PublishError)
      assert.match(error.message, /evals\/x\/1\/final\.md/)
      assert.doesNotMatch(error.message, /AIza/, 'names the file, not the secret')
      return true
    })
    assert.equal(sh(remote, 'branch', '--list'), '')
  })

  test('publishers that race all land, without merges, and the index stays whole', async () => {
    const remote = await bareRemote('remote-race-inproc')
    const n = 4
    const arrived: Array<() => void> = []
    let waiting = n
    // Every publisher derives against the same (empty) tip before any of them pushes, so all
    // but one must lose the race and redo their commit on top of the winner's.
    const barrier = () =>
      new Promise<void>((resolve) => {
        arrived.push(resolve)
        if (--waiting === 0) for (const release of arrived) release()
      })
    const runs = Array.from({ length: n }, () => fakeRun(newRunId()))
    for (let i = 0; i < n; i++) {
      await rm(join(tmp, `race-inproc-${i}`), { recursive: true, force: true })
      await mkdir(join(tmp, `race-inproc-${i}`), { recursive: true })
    }
    const reports = await Promise.all(
      runs.map(async (run, i) => {
        const store = gitBranchStore({ remote, root: join(tmp, `race-inproc-${i}`) })
        let first = true
        return store.commit({
          files: runFiles(run),
          message: `publish ${i}`,
          derive: async (view: StoreReader) => {
            if (first) {
              first = false
              await barrier()
            }
            return deriveStore(view)
          },
        })
      }),
    )
    assert.ok(reports.every((r) => r.changed))
    const attempts = reports.map((r) => r.attempts).sort()
    assert.equal(attempts[0], 1, 'one publisher wins the first round')
    assert.ok(
      attempts.slice(1).every((a) => a >= 2),
      `the others retried: ${attempts}`,
    )
    await assertRemoteWhole(
      remote,
      runs.map((r) => r.runId),
      n,
    )
  })

  test('four es publish processes racing on one remote', async (t) => {
    const remote = await bareRemote('remote-race-cli')
    const projects = []
    for (let i = 0; i < 4; i++) {
      const p = await gitProject(`race-cli-${i}`, { 'evals/math.es.ts': math(1) })
      assert.equal((await runCli(p.dir)).code, 0)
      projects.push(p)
    }
    const results = await Promise.all(
      projects.map((p) => runCli(p.dir, ['publish', '--remote', remote])),
    )
    for (const r of results) assert.equal(r.code, 0, r.stdout + r.stderr)
    const retried = results.filter((r) => /after \d+ attempts/.test(r.stdout)).length
    t.diagnostic(`${retried} of 4 publishers lost a race and retried`)
    const ids = projects.map((p) => readRun(p.dir).run.runId)
    await assertRemoteWhole(remote, ids, 4)

    const reader = await gitProject('race-cli-reader', {})
    assert.equal((await runCli(reader.dir, ['pull', '--remote', remote])).code, 0)
    const hist = await runCli(reader.dir, ['history', '--json'])
    const view = JSON.parse(hist.stdout)
    assert.equal(view.runs.length, 4)
    assert.deepEqual(view.rows[0].outcomes, ['pass', 'pass', 'pass', 'pass'])
  })
})

describe('history, show and compare', () => {
  test('a regression, a fix and a changed eval between two runs', async () => {
    const p = await gitProject('compare', {
      'evals/a.es.ts': math(1),
      'evals/b.es.ts': math(2),
      'evals/c.es.ts': math(1),
    })
    assert.equal((await runCli(p.dir)).code, 1)
    await writeFile(join(p.dir, 'evals/a.es.ts'), math(2))
    await writeFile(join(p.dir, 'evals/b.es.ts'), math(1))
    sh(p.dir, 'commit', '-qam', 'swap')
    await writeFile(join(p.dir, 'evals/c.es.ts'), `${math(1)}// changed\n`)
    assert.equal((await runCli(p.dir)).code, 1)

    const json = await runCli(p.dir, ['compare', '--json'])
    assert.equal(json.code, 0, json.stderr)
    const rows = Object.fromEntries(
      JSON.parse(json.stdout).rows.map((r: { id: string; status: string }) => [r.id, r.status]),
    )
    // a and b changed source too, so they're drift: only a fingerprint match can regress.
    assert.deepEqual(rows, {
      'evals/a.es.ts › math': 'drift',
      'evals/b.es.ts › math': 'drift',
      'evals/c.es.ts › math': 'drift',
    })

    // Rerun the head commit with c restored: a and b now match run 2's fingerprints.
    sh(p.dir, 'checkout', '-q', '--', 'evals/c.es.ts')
    assert.equal((await runCli(p.dir)).code, 1)
    const text = await runCli(p.dir, ['compare', 'latest~1', 'latest'])
    assert.equal(text.code, 0, text.stderr)
    assert.match(text.stdout, /0 regressed · 0 fixed · 1 not comparable · 2 same/)

    const md = await runCli(p.dir, ['compare', 'latest~2', 'latest', '--md'])
    assert.match(md.stdout, /^### ES: /)
    assert.match(md.stdout, /\| Eval \| Base \| Head \| Change \|/)

    const hist = await runCli(p.dir, ['history'])
    assert.equal(hist.code, 0)
    assert.match(hist.stdout, /3 runs, oldest → newest/)
    assert.match(hist.stdout, /✗¦✓✓ +2\/3 +evals\/b\.es\.ts › math/)
    assert.ok(!hist.stdout.includes('\u001b['), 'no ANSI when piped')

    const show = await runCli(p.dir, ['show', 'latest', '--json'])
    const shown: RunRecord = JSON.parse(show.stdout)
    assert.equal(shown.kind, 'es-run')
    assert.equal(shown.evals.length, 3)
    const table = await runCli(p.dir, ['show', shown.runId.slice(0, 20)])
    assert.match(table.stdout, new RegExp(`^run ${shown.runId}`))
    assert.equal((await runCli(p.dir, ['show', 'nope'])).code, 2)
  })

  test('compare reports a regression only when the fingerprint matches', async () => {
    // The outcome depends on a file outside the eval, so the fingerprint stays the same.
    const flaky = `import { existsSync } from 'node:fs'
import { evaluate, expect } from 'evalsuite'
evaluate('flaky', async () => expect(existsSync(new URL('../fail-flag', import.meta.url))).toBe(false))
`
    const p = await gitProject('regress', {
      'evals/flaky.es.ts': flaky,
      'evals/agent.es.ts': agent,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    await writeFile(join(p.dir, 'fail-flag'), '')
    assert.equal((await runCli(p.dir)).code, 1)
    const r = await runCli(p.dir, ['compare', '--fail-on-regression'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /1 regressed · 0 fixed · 0 not comparable · 1 same/)
    assert.match(r.stdout, /✓ → ✗ {2}regressed +evals\/flaky\.es\.ts › flaky/)

    // A judge threshold change is part of the fingerprint: drift, not a regression.
    await writeFile(
      join(p.dir, 'es.config.ts'),
      fakeConfig({
        harness: `{ files: { 'hello.txt': 'hi\\n' }, text: 'Wrote it' }`,
        judge: '{ model: fakeJudge({ score: 0.9 }), threshold: 0.95 }',
      }),
    )
    await rm(join(p.dir, 'fail-flag'))
    assert.equal((await runCli(p.dir)).code, 1)
    const drift = await runCli(p.dir, ['compare', 'latest~1', 'latest', '--fail-on-regression'])
    assert.equal(drift.code, 0, drift.stdout)
    assert.match(drift.stdout, /0 regressed · 0 fixed · 2 not comparable/)
  })
})

async function assertRemoteWhole(remote: string, runIds: string[], commits: number) {
  assert.equal(sh(remote, 'rev-list', '--count', 'es-results'), String(commits))
  assert.equal(sh(remote, 'rev-list', '--min-parents=2', 'es-results'), '', 'linear history')
  const files = remoteFiles(remote)
  for (const id of runIds) assert.ok(files.includes(`${runDir(id)}/run.json`), id)
  const index = JSON.parse(sh(remote, 'show', 'es-results:index.json'))
  assert.deepEqual(
    index.runs.map((r: { runId: string }) => r.runId),
    [...runIds].sort(),
  )
}

function fakeRun(runId: string): RunRecord {
  return {
    kind: 'es-run',
    schemaVersion: 3,
    runId,
    status: 'complete',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    git: null,
    runner: { kind: 'local', hostHash: 'test' },
    versions: { es: '0', vitest: '0', node: '0', agentCli: null, image: 'none' },
    config: {
      harness: 'fake',
      model: null,
      sandbox: 'fake',
      judgeModel: 'fake',
      threshold: 0.8,
      timeoutMs: 1,
      configHash: 'x',
    },
    redaction: { version: 1 },
    summary: { evals: 0, pass: 0, fail: 0, infraError: 0, skipped: 0 },
    evals: [],
  }
}

function runFiles(run: RunRecord): Map<string, Uint8Array> {
  const dir = runDir(run.runId)
  return new Map([
    [`${dir}/run.json`, encodeJson(run)],
    [`${dir}/summary.md`, Buffer.from(`# ${run.runId}\n`)],
  ])
}
