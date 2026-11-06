import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { encodeRecord } from '../src/history/files.ts'
import type { RunRecord } from '../src/history/types.ts'
import { s3Settings, s3Store } from '../src/store/s3.ts'
import { fakeConfig, project, runCli } from './helpers.ts'
import { type FakeS3, fakeS3 } from './support/fake-s3.ts'

const RUN = '20261105T120000Z_abcdef0_elliot_k3f9'
const bytes = (s: string) => new Uint8Array(Buffer.from(s))
const keyEnv = (s3: FakeS3) => ({
  AWS_ACCESS_KEY_ID: s3.accessKey,
  AWS_SECRET_ACCESS_KEY: s3.secretKey,
})

describe('s3Store', () => {
  let s3: FakeS3
  before(async () => {
    s3 = await fakeS3()
  })
  after(() => s3.close())

  test('creates a run once, record last, and replaces it only at the version it read', async () => {
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
    assert.deepEqual([...s3.objects.keys()].sort(), [
      'ci/reeval-store.json',
      `ci/runs/2026-11/${RUN}.json`,
      `ci/runs/2026-11/${RUN}/a/transcript.jsonl`,
      `ci/runs/2026-11/${RUN}/summary.md`,
    ])
    const puts = s3.requests.filter((r) => r.method === 'PUT').map((r) => r.key)
    assert.equal(puts.at(-1), `ci/runs/2026-11/${RUN}.json`, 'the record lands last')
    assert.equal(
      s3.requests.find((r) => r.method === 'PUT' && r.key.endsWith(`${RUN}.json`))?.headers[
        'if-none-match'
      ],
      '*',
    )
    const before = s3.requests.length
    assert.deepEqual(await store.writeRun(run, {}), { ok: false })
    assert.deepEqual(
      s3.requests.slice(before).filter((r) => r.method === 'PUT'),
      [],
      'a second create writes no file',
    )
    assert.deepEqual(await store.listRuns(), [{ runId: RUN, version: created.version }])
    const read = await store.readRun(RUN)
    assert.equal(Buffer.from(read?.record ?? []).toString(), '{"v":1}')
    assert.deepEqual([...(read?.files.keys() ?? [])].sort(), ['a/transcript.jsonl', 'summary.md'])
    assert.equal(read?.version, created.version)

    const next = {
      ...run,
      record: bytes('{"v":2}'),
      files: new Map([['summary.md', bytes('# two')]]),
    }
    assert.deepEqual(await store.writeRun(next, { replaces: 'stale' }), { ok: false })
    const replaced = await store.writeRun(next, { replaces: created.version })
    assert.ok(replaced.ok)
    assert.equal(
      s3.objects.has(`ci/runs/2026-11/${RUN}/a/transcript.jsonl`),
      false,
      'files it no longer names go',
    )
    assert.equal(await store.readRun('20261105T130000Z_abcdef0_elliot_zzzz'), null)
  })

  test('refuses a prefix another tool wrote a marker to', async () => {
    s3.objects.set('other/reeval-store.json', { bytes: Buffer.from('{"kind":"x"}'), etag: 'e' })
    const store = s3Store(
      { kind: 's3', bucket: s3.bucket, endpoint: s3.url, prefix: 'other' },
      keyEnv(s3),
    )
    await assert.rejects(
      store.writeRun({ runId: RUN, record: bytes('{}'), files: new Map() }, {}),
      /other\/reeval-store\.json isn't reeval's: give history\.store a prefix of its own/,
    )
  })

  test('a wrong key is the store refusing, not a conflict', async () => {
    const store = s3Store(
      { kind: 's3', bucket: s3.bucket, endpoint: s3.url },
      { AWS_ACCESS_KEY_ID: 'AKIAWRONG', AWS_SECRET_ACCESS_KEY: 'x' },
    )
    await assert.rejects(store.listRuns(), (e: { statusCode?: number }) => e.statusCode === 403)
  })
})

test('s3() settings come from the descriptor and the variables it names', () => {
  const r2 = s3Settings(
    {
      kind: 's3',
      env: {
        endpoint: 'R2_ENDPOINT',
        bucket: 'R2_BUCKET',
        accessKeyId: 'R2_ACCESS_KEY_ID',
        secretAccessKey: 'R2_SECRET_ACCESS_KEY',
      },
    },
    {
      R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      R2_BUCKET: 'reeval-history-dev',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      AWS_ACCESS_KEY_ID: 'not this one',
    },
  )
  assert.deepEqual(r2, {
    endPoint: 'https://acct.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'reeval-history-dev',
    accessKey: 'id',
    secretKey: 'secret',
  })
  const aws = s3Settings(
    { kind: 's3', bucket: 'runs' },
    {
      AWS_ACCESS_KEY_ID: 'id',
      AWS_SECRET_ACCESS_KEY: 's',
      AWS_SESSION_TOKEN: 't',
      AWS_REGION: 'eu-west-1',
    },
  )
  assert.equal(aws.endPoint, 'https://s3.eu-west-1.amazonaws.com')
  assert.equal(aws.sessionToken, 't')
  const missing = (env: Record<string, string>, pattern: RegExp) =>
    assert.throws(
      () => s3Settings({ kind: 's3', bucket: 'runs', env: { endpoint: 'R2_ENDPOINT' } }, env),
      (e: Error) => e instanceof UsageError && pattern.test(e.message),
    )
  missing({}, /s3:\/\/runs needs its endpoint: set R2_ENDPOINT in the environment/)
  missing({ R2_ENDPOINT: 'https://x.example' }, /needs an access key: set AWS_ACCESS_KEY_ID/)
  missing(
    { R2_ENDPOINT: 'https://x.example', AWS_ACCESS_KEY_ID: 'id' },
    /needs a secret key: set AWS_SECRET_ACCESS_KEY/,
  )
  missing(
    { R2_ENDPOINT: 'https://key:secret@x.example' },
    /R2_ENDPOINT in the environment has credentials in it/,
  )
})

describe('recording to s3()', () => {
  let s3: FakeS3
  let dir: string
  before(async () => {
    s3 = await fakeS3()
    const p = await project('store-s3', {
      'reeval.config.ts': fakeConfig({
        extra: `record: 'manual',
  profiles: {
    ci: { history: { store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}', prefix: 'ci' } } },
  },`,
      }),
      'evals/a.eval.ts': "import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n",
    })
    dir = p.dir
  })
  after(() => s3.close())

  const env = () => ({ ...keyEnv(s3), CI: 'false', GITHUB_ACTIONS: 'false' })
  const storeDir = () => {
    const [id] = readdirSync(join(dir, '.reeval/store'))
    return join(dir, '.reeval/store', id as string)
  }
  const remoteRecords = () =>
    [...s3.objects.keys()].filter((k) => /^ci\/runs\/\d{4}-\d{2}\/[^/]+\.json$/.test(k))

  test('a recorded run uploads to the bucket, and nothing lands in the history folder', async () => {
    const r = await runCli(dir, ['run', '--profile', 'ci', '--record'], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^recorded \S+ in s3:\/\/reeval-runs\/ci \(\d+ files, [\d.]+ KB\)$/m)
    assert.equal(remoteRecords().length, 1)
    assert.equal(existsSync(join(dir, 'evals/.history')), false)
    assert.equal(existsSync(join(storeDir(), 'history/.gitignore')), false)
    assert.deepEqual(readdirSync(join(storeDir(), 'pending')), [])
    const [key] = remoteRecords()
    const record = JSON.parse(String(s3.objects.get(key as string)?.bytes)) as RunRecord
    const copy = readFileSync(join(storeDir(), 'history', `${record.runId}.json`))
    assert.ok(copy.equals(encodeRecord(record)), 'the bucket holds the copy byte for byte')
    const again = await runCli(dir, ['record', '--profile', 'ci', record.runId], { env: env() })
    assert.equal(again.code, 0, again.stdout + again.stderr)
    assert.match(again.stdout, /is already recorded in s3:\/\/reeval-runs\/ci/)
  })

  test('another version in the bucket is refused, and an interrupted one is replaced', async () => {
    const [key] = remoteRecords()
    const object = s3.objects.get(key as string) as { bytes: Buffer; etag: string }
    const record = JSON.parse(String(object.bytes)) as RunRecord
    const swap = (r: RunRecord) => {
      const b = encodeRecord(r)
      s3.objects.set(key as string, { bytes: b, etag: `${object.etag}-${r.status}-${b.length}` })
    }
    swap({ ...record, branch: 'elsewhere' } as RunRecord)
    const files = [...s3.objects.keys()].filter((k) => k.startsWith(`${key?.slice(0, -5)}/`))
    assert.ok(files.length > 0)
    for (const file of files) s3.objects.set(file, { bytes: Buffer.from('stored'), etag: 'stored' })
    const refused = await runCli(dir, ['record', '--profile', 'ci', record.runId], { env: env() })
    assert.equal(refused.code, 3, refused.stdout + refused.stderr)
    for (const file of files) {
      assert.equal(String(s3.objects.get(file)?.bytes), 'stored', `${file} isn't overwritten`)
    }
    assert.match(
      refused.stderr,
      new RegExp(
        `${record.runId} is already in s3://reeval-runs/ci with different content\\. Recorded runs are never rewritten\\. The run is kept in`,
      ),
    )
    assert.doesNotMatch(refused.stderr, /reeval report/, 'a store that refused is no bug of reeval')
    swap({ ...record, status: 'interrupted' })
    const replaced = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(replaced.code, 0, replaced.stdout + replaced.stderr)
    assert.ok(s3.objects.get(key as string)?.bytes.equals(encodeRecord(record)))
  })

  test('a store that keeps failing exits 3 and keeps the run for reeval sync', async () => {
    const before = remoteRecords().length
    s3.failNext(100)
    const r = await runCli(dir, ['run', '--profile', 'ci', '--record'], {
      env: { ...env(), GITHUB_ACTIONS: 'true' },
    })
    s3.failNext(0)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /reeval: couldn't upload \S+ to s3:\/\/reeval-runs\/ci: .*\(503 ServiceUnavailable\)\. The run is kept in \.reeval\/store\/[0-9a-f]{12}\/pending; reeval sync uploads it\./,
    )
    assert.match(r.stderr, /^::error title=reeval: run not uploaded::couldn't upload /m)
    assert.equal(remoteRecords().length, before)
    const [pending] = readdirSync(join(storeDir(), 'pending'))
    assert.ok(pending)
    const synced = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(synced.code, 0, synced.stdout + synced.stderr)
    assert.match(synced.stdout, new RegExp(`uploaded to s3://reeval-runs/ci: ${pending}`))
    assert.equal(remoteRecords().length, before + 1)
    assert.deepEqual(readdirSync(join(storeDir(), 'pending')), [])
    const idle = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.match(idle.stdout, /nothing to upload to s3:\/\/reeval-runs\/ci/)
  })

  test('a refused key, 403 or R2 401, names the variables and is not retried', async () => {
    const wrong = await runCli(dir, ['run', '--profile', 'ci', '--record'], {
      env: { ...env(), AWS_ACCESS_KEY_ID: 'AKIAWRONG' },
    })
    assert.equal(wrong.code, 3, wrong.stdout + wrong.stderr)
    assert.match(
      wrong.stdout,
      /\(403 InvalidAccessKeyId\): check that AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY hold a key with access to the bucket\. The run is kept in /,
    )
    const requests = s3.requests.length
    s3.failNext(100, 401)
    const r2 = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    s3.failNext(0)
    assert.equal(r2.code, 3, r2.stdout + r2.stderr)
    assert.match(r2.stderr, /Unauthorized \(401 Unauthorized\): check that AWS_ACCESS_KEY_ID and /)
    assert.equal(s3.requests.length - requests, 1, 'a 401 is not retried')
    const synced = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(synced.code, 0, synced.stdout + synced.stderr)
  })

  test('a marker whose run never reached the copy is dropped, and a bug is not retried', async () => {
    const orphan = join(storeDir(), 'pending', RUN)
    writeFileSync(orphan, '')
    const sync = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(sync.code, 0, sync.stdout + sync.stderr)
    assert.match(sync.stdout, /nothing to upload to s3:\/\/reeval-runs\/ci/)
    assert.equal(existsSync(orphan), false)

    const marker = s3.objects.get('ci/reeval-store.json') as { bytes: Buffer; etag: string }
    s3.objects.set('ci/reeval-store.json', { bytes: Buffer.from('not json'), etag: 'x' })
    const requests = s3.requests.length
    const r = await runCli(dir, ['run', '--profile', 'ci', '--record'], { env: env() })
    s3.objects.set('ci/reeval-store.json', marker)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    const reads = s3.requests.slice(requests).filter((q) => q.key === 'ci/reeval-store.json')
    assert.equal(reads.length, 1, 'a marker that is not JSON is read once, not retried')
    const synced = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(synced.code, 0, synced.stdout + synced.stderr)
  })

  test('the keys can be in .env.local, and analyze --save is refused', async () => {
    writeFileSync(
      join(dir, '.env.local'),
      `AWS_ACCESS_KEY_ID=${s3.accessKey}\nAWS_SECRET_ACCESS_KEY=${s3.secretKey}\n`,
    )
    const sync = await runCli(dir, ['sync', '--profile', 'ci'], { env: { CI: 'false' } })
    rmSync(join(dir, '.env.local'))
    assert.equal(sync.code, 0, sync.stdout + sync.stderr)
    const save = await runCli(dir, ['analyze', '--profile', 'ci', '--save'], { env: env() })
    assert.equal(save.code, 2, save.stdout + save.stderr)
    assert.match(
      save.stderr,
      /reeval analyze --save writes into a local\(\) history, and history\.store in reeval\.config\.ts keeps runs in s3:\/\/reeval-runs\/ci\. Drop --save/,
    )
  })

  test('one failed try is retried', async () => {
    const before = remoteRecords().length
    s3.failNext(1)
    const r = await runCli(dir, ['run', '--profile', 'ci', '--record'], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(remoteRecords().length, before + 1)
  })

  test('a run that would record without the keys stops before it runs', async () => {
    const r = await runCli(dir, ['run', '--profile', 'ci', '--record'], {
      env: { CI: 'false', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
    })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /^reeval: s3:\/\/reeval-runs\/ci needs an access key: set AWS_ACCESS_KEY_ID in the environment/m,
    )
    assert.doesNotMatch(r.stdout, /passed|failed/)
    const plan = await runCli(dir, ['run', '--profile', 'ci', '--record', '--dry-run'], {
      env: { CI: 'false', AWS_ACCESS_KEY_ID: '' },
    })
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
  })

  test('the studio refuses a remote store; sync on local() has nothing to do', async () => {
    const studio = await runCli(dir, ['studio', 'build', '--profile', 'ci'], { env: env() })
    assert.equal(studio.code, 2, studio.stdout + studio.stderr)
    assert.match(
      studio.stderr,
      /reeval studio reads a local\(\) history only, and history\.store in reeval\.config\.ts keeps runs in s3:\/\/reeval-runs\/ci\./,
    )
    const local = await runCli(dir, ['sync'], { env: env() })
    assert.equal(local.code, 0, local.stdout + local.stderr)
    assert.match(
      local.stdout,
      /history\.store is local\(\): runs are recorded in evals\/\.history, nothing to sync/,
    )
  })
})
