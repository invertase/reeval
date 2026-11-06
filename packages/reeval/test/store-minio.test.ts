// The store suite's Docker tier: s3() on a real S3 API (MinIO in a container), where the fake in
// store.test.ts can't vouch for conditional writes, signing or listing. Skips without Docker
// unless REEVAL_TEST_REQUIRE_DOCKER=1 (CI's docker job), which fails instead.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { RunRecord } from '../src/history/types.ts'
import { s3Store } from '../src/store/s3.ts'
import { fakeConfig, project, runCli, tempDir } from './helpers.ts'
import { dockerRunning, type Minio, startMinio } from './support/minio.ts'

const requireDocker = process.env.REEVAL_TEST_REQUIRE_DOCKER === '1'
const skip = !requireDocker && !(await dockerRunning()) && 'needs Docker'

const RUN = '20261105T120000Z_abcdef0_elliot_k3f9'
const bytes = (s: string) => new Uint8Array(Buffer.from(s))
const keyEnv = (s3: Minio) => ({
  AWS_ACCESS_KEY_ID: s3.accessKey,
  AWS_SECRET_ACCESS_KEY: s3.secretKey,
})

describe('s3Store on MinIO', { skip }, () => {
  let s3: Minio
  before(async () => {
    s3 = await startMinio()
  })
  after(() => s3?.close())

  test('creates a run once, and replaces it only at the version it read', async () => {
    const store = s3Store(
      { kind: 's3', bucket: s3.bucket, endpoint: s3.url, prefix: 'ci' },
      keyEnv(s3),
    )
    const run = {
      runId: RUN,
      record: bytes('{"v":1}'),
      files: new Map([
        ['summary.md', bytes('# one')],
        ['a/transcript.jsonl', bytes('{}')],
      ]),
    }
    const created = await store.writeRun(run, {})
    assert.ok(created.ok)
    assert.deepEqual(await s3.keys('ci/'), [
      'ci/reeval-store.json',
      `ci/runs/2026-11/${RUN}.json`,
      `ci/runs/2026-11/${RUN}/a/transcript.jsonl`,
      `ci/runs/2026-11/${RUN}/summary.md`,
    ])
    assert.deepEqual(await store.writeRun(run, {}), { ok: false }, 'If-None-Match: * holds')
    assert.deepEqual(await store.listRuns(), [{ runId: RUN, version: created.version }])
    const read = await store.readRun(RUN)
    assert.equal(Buffer.from(read?.record ?? []).toString(), '{"v":1}')
    assert.equal(read?.version, created.version)

    const next = { ...run, record: bytes('{"v":2}'), files: new Map([['summary.md', bytes('#')]]) }
    assert.deepEqual(
      await store.writeRun(next, { replaces: '0123456789abcdef0123456789abcdef' }),
      { ok: false },
      'If-Match holds',
    )
    const replaced = await store.writeRun(next, { replaces: created.version })
    assert.ok(replaced.ok)
    assert.notEqual(replaced.version, created.version)
    assert.equal(await s3.read(`ci/runs/2026-11/${RUN}.json`), '{"v":2}')
    assert.deepEqual(await s3.keys(`ci/runs/2026-11/${RUN}/`), [
      `ci/runs/2026-11/${RUN}/summary.md`,
    ])

    await store.addFile(RUN, 'debug/a/c/1/requests.ndjson', bytes('{}\n'))
    assert.deepEqual(await s3.keys('ci/debug/'), [`ci/debug/2026-11/${RUN}/a/c/1/requests.ndjson`])
    assert.deepEqual(await store.listRuns(), [{ runId: RUN, version: replaced.version }])
  })

  test("refuses a prefix another tool's marker is in, and a wrong key", async () => {
    await s3.client.putObject('other/reeval-store.json', '{"kind":"x"}')
    const other = s3Store(
      { kind: 's3', bucket: s3.bucket, endpoint: s3.url, prefix: 'other' },
      keyEnv(s3),
    )
    await assert.rejects(
      other.writeRun({ runId: RUN, record: bytes('{}'), files: new Map() }, {}),
      /other\/reeval-store\.json isn't reeval's/,
    )
    const wrong = s3Store(
      { kind: 's3', bucket: s3.bucket, endpoint: s3.url },
      { AWS_ACCESS_KEY_ID: 'AKIAWRONG', AWS_SECRET_ACCESS_KEY: 'wrong-secret' },
    )
    await assert.rejects(wrong.listRuns(), (e: { statusCode?: number }) => e.statusCode === 403)
  })
})

describe('reeval on MinIO', { skip }, () => {
  let s3: Minio
  let a: string
  let b: string
  const ids: Record<string, string> = {}
  const env = () => ({ ...keyEnv(s3), CI: 'false', GITHUB_ACTIONS: 'false' })
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'r',
        GIT_AUTHOR_EMAIL: 'r@example.com',
        GIT_COMMITTER_NAME: 'r',
        GIT_COMMITTER_EMAIL: 'r@example.com',
      },
    }).trim()
  const month = (runId: string) => `${runId.slice(0, 4)}-${runId.slice(4, 6)}`
  const recordOn = async (cwd: string, name: string) => {
    writeFileSync(join(cwd, `${name}.txt`), name)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-qm', name)
    const r = await runCli(cwd, ['run', '--profile', 'ci', '--record'], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^recorded \S+ in s3:\/\/reeval-runs\/team \(\d+ files, .*debug file/m)
    ids[name] = /^recorded (\S+) in /m.exec(r.stdout)?.[1] as string
  }
  const listed = async (cwd: string, ...flags: string[]) => {
    const r = await runCli(cwd, ['history', '--profile', 'ci', '--json', ...flags], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    return (JSON.parse(r.stdout) as { runs: Array<{ runId: string }> }).runs.map((x) => x.runId)
  }

  before(async () => {
    s3 = await startMinio()
    const p = await project('store-minio', {
      '.gitignore': 'node_modules\n.reeval\nsandboxes\n',
      'reeval.config.ts': fakeConfig({
        extra: `record: 'manual',
  profiles: {
    ci: {
      history: {
        store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}', prefix: 'team' },
        debug: 'all',
      },
    },
  },`,
      }),
      'evals/a.eval.ts': "import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n",
    })
    a = p.dir
    git(a, 'init', '-q', '-b', 'main')
    await recordOn(a, 'main')
    git(a, 'checkout', '-qb', 'feature')
    await recordOn(a, 'feature')
    git(a, 'checkout', '-q', 'main')
    b = tempDir('store-minio-clone')
    rmSync(b, { recursive: true, force: true })
    git(a, 'clone', '-q', a, b)
    symlinkSync(join(a, 'node_modules'), join(b, 'node_modules'), 'dir')
  })
  after(() => s3?.close())

  test('a recorded run is in the bucket, its debug data under debug/', async () => {
    const runId = ids.main as string
    const record = JSON.parse(await s3.read(`team/runs/${month(runId)}/${runId}.json`)) as RunRecord
    assert.equal(record.runId, runId)
    assert.equal(record.debug?.level, 'all')
    const debug = await s3.keys(`team/debug/${month(runId)}/${runId}/`)
    assert.ok(
      debug.some((k) => k.endsWith('/debug.log')),
      `debug.log uploaded: ${debug.join(', ')}`,
    )
    assert.equal(debug.length, record.debug?.files.length)
  })

  test("another clone pulls the runs, HEAD's by default, and checks one out", async () => {
    assert.deepEqual(await listed(b), [ids.main])
    assert.deepEqual(await listed(b, '--all-branches', '--offline'), [ids.main, ids.feature])
    const [id] = readdirSync(join(b, '.reeval/store'))
    const copy = join(b, '.reeval/store', id as string, 'history')
    assert.ok(
      !readdirSync(copy, { recursive: true }).some((f) => String(f).includes('debug.log')),
      'a pull never downloads debug data',
    )
    const target = join(b, '.reeval/checkouts/feature')
    const co = await runCli(b, ['checkout', '--profile', 'ci', ids.feature as string, target], {
      env: env(),
    })
    assert.equal(co.code, 0, co.stdout + co.stderr)
    assert.equal(readFileSync(join(target, 'feature.txt'), 'utf8'), 'feature')
  })

  test("reeval sync --debug brings one run's debug data to the other clone", async () => {
    const runId = ids.main as string
    const r = await runCli(b, ['sync', '--profile', 'ci', '--debug', runId], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      new RegExp(
        `^downloaded \\d+ debug files? of ${runId} .* into \\.reeval/debug/${runId}$`,
        'm',
      ),
    )
    const record = JSON.parse(await s3.read(`team/runs/${month(runId)}/${runId}.json`)) as RunRecord
    for (const file of record.debug?.files ?? []) {
      assert.deepEqual(
        readFileSync(join(b, '.reeval/debug', runId, file.path)),
        readFileSync(join(a, '.reeval/debug', runId, file.path)),
        file.path,
      )
    }
    const again = await runCli(b, ['sync', '--profile', 'ci', '--debug', runId], { env: env() })
    assert.match(again.stdout, /debug data is already in \.reeval\/debug\//)
  })

  test('recording a run again is a no-op, and sync has nothing to do', async () => {
    const again = await runCli(a, ['record', '--profile', 'ci', ids.main as string], {
      env: env(),
    })
    assert.equal(again.code, 0, again.stdout + again.stderr)
    assert.match(again.stdout, /is already recorded in s3:\/\/reeval-runs\/team/)
    const sync = await runCli(a, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(sync.code, 0, sync.stdout + sync.stderr)
    assert.match(sync.stdout, /nothing to upload, pulled 0 run\(s\) from s3:\/\/reeval-runs\/team/)
  })
})
