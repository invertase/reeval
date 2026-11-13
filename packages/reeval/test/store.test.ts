import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { encodeRecord } from '../src/history/files.ts'
import type { RunRecord } from '../src/history/types.ts'
import { resolveHistory } from '../src/store/resolve.ts'
import { s3Settings, s3Store } from '../src/store/s3.ts'
import { transient } from '../src/store/sync.ts'
import type { RunEventLine } from '../src/view/events.ts'
import { fakeConfig, noSignals, project, runCli, tempDir } from './helpers.ts'
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

  /** The `recorded` paths the run's `run-end` event named, from `stream` in `dir`. */
  const recordedIn = (stream: string) => {
    const end = readFileSync(join(dir, stream), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunEventLine)
      .find((l) => l.type === 'run-end')
    return end?.type === 'run-end' ? end.recorded : undefined
  }

  test('a recorded run uploads to the bucket, and nothing lands in the history folder', async () => {
    const r = await runCli(
      dir,
      ['run', '--profile', 'ci', '--record', '--events-file', 'uploaded.ndjson'],
      { env: env() },
    )
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const named = recordedIn('uploaded.ndjson')
    assert.match(named?.record ?? '', /^\.reeval\/store\/[0-9a-f]{12}\/history\/[^/]+\.json$/)
    assert.ok(existsSync(join(dir, named?.record ?? '')), 'run-end names the store copy')
    assert.equal(named?.files, named?.record.slice(0, -5))
    assert.ok(existsSync(join(dir, named?.files ?? '', 'summary.md')))
    assert.equal(named?.archive, undefined)
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
    const r = await runCli(
      dir,
      ['run', '--profile', 'ci', '--record', '--events-file', 'pending.ndjson'],
      { env: { ...env(), GITHUB_ACTIONS: 'true' } },
    )
    s3.failNext(0)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    const named = recordedIn('pending.ndjson')?.record ?? ''
    assert.ok(existsSync(join(dir, named)), 'run-end names the copy the upload left pending')
    const summary = r.stdout.search(/summary \.reeval\/runs\//)
    assert.ok(summary >= 0 && summary < r.stdout.search(/couldn't upload/), 'the summary first')
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
    assert.match(idle.stdout, /nothing to upload, pulled 0 run\(s\) from s3:\/\/reeval-runs\/ci/)
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

  test('a stale marker whose run never reached the copy is dropped, and a bug is not retried', async () => {
    const orphan = join(storeDir(), 'pending', RUN)
    writeFileSync(orphan, '')
    const young = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(young.code, 0, young.stdout + young.stderr)
    assert.match(young.stdout, /nothing to upload/)
    assert.ok(existsSync(orphan), "a fresh marker can be another process's recording, so it stays")
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(orphan, old, old)
    const sync = await runCli(dir, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(sync.code, 0, sync.stdout + sync.stderr)
    assert.match(sync.stdout, /nothing to upload/)
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

  test('sync --push-only uploads and checks the store without listing it', async () => {
    const recorded = await runCli(dir, ['run', '--profile', 'ci', '--record'], { env: env() })
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr)
    const requests = s3.requests.length
    const r = await runCli(dir, ['sync', '--profile', 'ci', '--push-only'], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^nothing to upload to s3:\/\/reeval-runs\/ci, which answers; pulled nothing \(--push-only\)$/m,
    )
    const made = s3.requests.slice(requests)
    assert.ok(made.length > 0, 'it reaches the store')
    assert.ok(
      made.every((q) => q.key === 'ci/reeval-store.json'),
      made.map((q) => `${q.method} ${q.key}`).join(', '),
    )
    s3.failNext(3, 503)
    const down = await runCli(dir, ['sync', '--profile', 'ci', '--push-only'], { env: env() })
    assert.equal(down.code, 3, down.stdout + down.stderr)
    assert.match(down.stderr, /couldn't read s3:\/\/reeval-runs\/ci: /)
    const both = await runCli(dir, ['sync', '--profile', 'ci', '--push-only', '--debug'], {
      env: env(),
    })
    assert.equal(both.code, 2, both.stdout + both.stderr)
    assert.match(both.stderr, /--debug downloads, and --push-only does not/)
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
    const studio = await runCli(dir, ['studio', '--no-open', '--profile', 'ci'], { env: env() })
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

test("the copy is keyed on where the store's variables point now", () => {
  const dir = (env: Record<string, string>) => {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      const store = { kind: 's3', env: { bucket: 'RUNS_BUCKET', endpoint: 'RUNS_ENDPOINT' } }
      return resolveHistory({ store }, 'history', 'reeval.yaml', '/p', 'evals/.history').dir
    } finally {
      process.env = saved
    }
  }
  const one = dir({ RUNS_BUCKET: 'one', RUNS_ENDPOINT: 'https://s3.example.com' })
  assert.equal(dir({ RUNS_BUCKET: 'one', RUNS_ENDPOINT: 'https://s3.example.com/' }), one)
  assert.notEqual(dir({ RUNS_BUCKET: 'two', RUNS_ENDPOINT: 'https://s3.example.com' }), one)
  assert.notEqual(dir({ RUNS_BUCKET: 'one', RUNS_ENDPOINT: 'https://r2.example.com' }), one)
})

describe('reading from s3()', () => {
  let s3: FakeS3
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
  const recordOn = async (cwd: string, name: string) => {
    writeFileSync(join(cwd, `${name}.txt`), name)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-qm', name)
    const r = await runCli(cwd, ['run', '--profile', 'ci', '--record'], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    ids[name] = /^recorded (\S+) in /m.exec(r.stdout)?.[1] as string
  }
  const listed = async (cwd: string, ...flags: string[]) => {
    const r = await runCli(cwd, ['history', '--profile', 'ci', '--json', ...flags], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const view = JSON.parse(r.stdout) as { runs: Array<{ runId: string }>; orphaned: string[] }
    return { ids: view.runs.map((run) => run.runId), orphaned: view.orphaned, stderr: r.stderr }
  }
  const storeDir = (cwd: string) => {
    const [id] = readdirSync(join(cwd, '.reeval/store'))
    return join(cwd, '.reeval/store', id as string)
  }
  const age = (cwd: string) => {
    const file = join(storeDir(cwd), 'pulled.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...state, at: '2026-01-01T00:00:00.000Z' }))
  }

  before(async () => {
    s3 = await fakeS3()
    const p = await project('store-read', {
      '.gitignore': 'node_modules\n.reeval\nsandboxes\n',
      'reeval.config.ts': fakeConfig({
        extra: `record: 'manual',
  profiles: {
    ci: { history: { store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}' } } },
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
    b = tempDir('store-read-clone')
    rmSync(b, { recursive: true, force: true })
    git(a, 'clone', '-q', a, b)
    symlinkSync(join(a, 'node_modules'), join(b, 'node_modules'), 'dir')
    git(a, 'checkout', '-q', 'feature')
    await recordOn(a, 'later')
    git(a, 'checkout', '-q', 'main')
  })
  after(() => s3.close())

  test("another clone pulls the store's runs and lists those HEAD reaches", async () => {
    const shown = await listed(b)
    assert.deepEqual(shown.ids, [ids.main])
    assert.deepEqual(shown.orphaned, [], 'a remote store lists no runs as rebased away')
    const all = await listed(b, '--all-branches', '--offline')
    assert.deepEqual(all.ids, [ids.main, ids.feature, ids.later])
    const one = await runCli(b, ['show', '--profile', 'ci', '--json', ids.feature as string], {
      env: env(),
    })
    assert.equal(one.code, 0, one.stdout + one.stderr)
    assert.equal(JSON.parse(one.stdout).runId, ids.feature, 'a run id finds any branch')
    const own = await runCli(a, ['sync', '--profile', 'ci'], { env: env() })
    assert.match(own.stdout, /nothing to upload, pulled 0 run\(s\)/, 'its own uploads are known')
  })

  test('checkout fetches a commit the clone lacks', async () => {
    const target = join(b, '.reeval/checkouts/later')
    const r = await runCli(b, ['checkout', '--profile', 'ci', ids.later as string, target], {
      env: env(),
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(readFileSync(join(target, 'later.txt'), 'utf8'), 'later')
  })

  test('an unreachable store shows the copy, and with no copy exits 3', async () => {
    age(b)
    s3.failNext(100)
    const cached = await listed(b)
    s3.failNext(0)
    assert.deepEqual(cached.ids, [ids.main])
    assert.match(
      cached.stderr,
      /s3:\/\/reeval-runs is unreachable \(.*\); showing the runs pulled at 20\d\d-/,
    )
    const fresh = tempDir('store-read-empty')
    rmSync(fresh, { recursive: true, force: true })
    git(a, 'clone', '-q', a, fresh)
    symlinkSync(join(a, 'node_modules'), join(fresh, 'node_modules'), 'dir')
    s3.failNext(100)
    const none = await runCli(fresh, ['history', '--profile', 'ci'], { env: env() })
    s3.failNext(0)
    assert.equal(none.code, 3, none.stdout + none.stderr)
    assert.match(none.stderr, /couldn't read s3:\/\/reeval-runs: /)
    const offline = await runCli(fresh, ['history', '--profile', 'ci', '--offline'], { env: env() })
    assert.equal(offline.code, 0, offline.stdout + offline.stderr)
    assert.match(offline.stdout, /No recorded runs yet/)
  })

  test('a pull skips a run whose files fail their hashes, and keys outside the run', async () => {
    const runId = ids.main as string
    const base = `runs/${runId.slice(0, 4)}-${runId.slice(4, 6)}/${runId}`
    const record = s3.objects.get(`${base}.json`) as { bytes: Buffer; etag: string }
    const run = JSON.parse(String(record.bytes)) as RunRecord
    const wrong = { path: 'summary.md', sha256: '0'.repeat(64), bytes: 1 }
    const bad = encodeRecord({ ...run, git: { ...run.git, worktreePatch: wrong } } as RunRecord)
    s3.objects.set(`${base}.json`, { bytes: bad, etag: 'tampered' })
    s3.objects.set(`${base}/a/../evil.txt`, { bytes: Buffer.from('evil'), etag: 'evil' })
    const skipped = await runCli(b, ['sync', '--profile', 'ci'], { env: env() })
    assert.equal(skipped.code, 0, skipped.stdout + skipped.stderr)
    assert.match(skipped.stdout, /pulled 0 run\(s\)/)
    assert.match(
      skipped.stderr,
      new RegExp(
        `warning: skipped ${runId} from s3://reeval-runs: summary\\.md doesn't match the hash in its record, so the next pull reads it again`,
      ),
    )
    assert.match(
      skipped.stderr,
      /warning: skipped \S+\/a\/\.\.\/evil\.txt in s3:\/\/reeval-runs: a key with an empty, \. or \.\. part can't be read back/,
    )
    const copy = readFileSync(join(storeDir(b), 'history', `${runId}.json`))
    assert.ok(copy.equals(record.bytes), 'the copy keeps what it had')
    s3.objects.set(`${base}.json`, { ...record, etag: 'next' })
    const pulled = await runCli(b, ['sync', '--profile', 'ci'], { env: env() })
    s3.objects.delete(`${base}/a/../evil.txt`)
    assert.equal(pulled.code, 0, pulled.stdout + pulled.stderr)
    assert.match(pulled.stdout, /pulled 1 run\(s\)/)
    assert.doesNotMatch(pulled.stderr, /doesn't match/)
    assert.equal(existsSync(join(storeDir(b), 'history', 'evil.txt')), false)
  })
})

describe('debug data to s3()', () => {
  let s3: FakeS3
  let dir: string
  const env = () => ({ ...keyEnv(s3), CI: 'false', GITHUB_ACTIONS: 'false' })
  const store = (level: string) =>
    `{ history: { store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}', prefix: 'dbg' }, debug: '${level}' } }`
  before(async () => {
    s3 = await fakeS3()
    const p = await project('store-debug', {
      'reeval.config.ts': fakeConfig({
        extra: `record: 'manual',
  profiles: { requests: ${store('requests')}, all: ${store('all')} },`,
      }),
      'evals/a.eval.ts': "import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n",
    })
    dir = p.dir
  })
  after(() => s3.close())

  const debugDir = () => join(dir, '.reeval/debug')
  /** Runs once, unrecorded, and returns its id and its one attempt's debug path. */
  const runOnce = async () => {
    const r = await runCli(dir, ['run'], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const runId = readdirSync(debugDir()).sort().at(-1) as string
    const attempt = (function find(at: string): string {
      const [name] = readdirSync(join(debugDir(), runId, at))
      const next = at ? `${at}/${name}` : (name as string)
      return /^\d+$/.test(name as string) ? next : find(next)
    })('')
    return { runId, attempt }
  }
  const month = (runId: string) => `${runId.slice(0, 4)}-${runId.slice(4, 6)}`
  const uploaded = (runId: string) =>
    [...s3.objects.keys()]
      .filter((k) => k.startsWith(`dbg/debug/${month(runId)}/${runId}/`))
      .map((k) => k.slice(`dbg/debug/${month(runId)}/${runId}/`.length))
      .sort()
  const recordIn = (runId: string) =>
    JSON.parse(String(s3.objects.get(`dbg/runs/${month(runId)}/${runId}.json`)?.bytes)) as RunRecord
  const storeDir = () => {
    const [id] = readdirSync(join(dir, '.reeval/store'))
    return join(dir, '.reeval/store', id as string)
  }
  const key = `AIza${'Q'.repeat(31)}WXYZ`

  test("'requests' uploads each requests.ndjson beside the run, and leaves out one with a secret", async () => {
    const { runId, attempt } = await runOnce()
    const clean = '{"method":"POST","url":"https://api.example.com/v1/chat"}\n'
    writeFileSync(join(debugDir(), runId, attempt, 'requests.ndjson'), clean)
    mkdirSync(join(debugDir(), runId, 'a/other/2'), { recursive: true })
    writeFileSync(join(debugDir(), runId, 'a/other/2/requests.ndjson'), `{"key":"${key}"}\n`)
    const r = await runCli(dir, ['record', '--profile', 'requests', runId], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      new RegExp(
        `^warning: left debug/a/other/2/requests\\.ndjson out of ${runId}'s upload: it looked like it held a secret \\(line 1: Google API key\\)$`,
        'm',
      ),
    )
    assert.match(r.stdout, /, 1 debug file, [\d.]+ KB\)$/m)
    assert.deepEqual(uploaded(runId), [`${attempt}/requests.ndjson`])
    const path = `dbg/debug/${month(runId)}/${runId}/${attempt}/requests.ndjson`
    assert.equal(String(s3.objects.get(path)?.bytes), clean)
    const { debug } = recordIn(runId)
    assert.equal(debug?.level, 'requests')
    assert.deepEqual(
      debug?.files.map((f) => f.path),
      [`${attempt}/requests.ndjson`],
    )
    assert.deepEqual(
      debug?.dropped?.map((d) => d.path),
      ['a/other/2/requests.ndjson'],
    )
    assert.ok(
      ![...s3.objects.keys()].some((k) => k.startsWith(`dbg/runs/`) && k.includes('/debug/')),
      'nothing of it is under runs/, which a pull lists',
    )
    assert.equal(existsSync(join(storeDir(), 'debug', runId)), false, 'the staging is gone')
    assert.ok(![...s3.objects.values()].some((o) => String(o.bytes).includes(key)))
  })

  test('--skip-secret-scan still scans the debug data', async () => {
    const { runId, attempt } = await runOnce()
    writeFileSync(join(debugDir(), runId, attempt, 'requests.ndjson'), `{"key":"${key}"}\n`)
    const r = await runCli(dir, ['record', '--profile', 'requests', '--skip-secret-scan', runId], {
      env: env(),
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^warning: left debug\/\S+requests\.ndjson out of /m)
    assert.deepEqual(uploaded(runId), [])
    assert.ok(![...s3.objects.values()].some((o) => String(o.bytes).includes(key)))
  })

  test('re-recording a run whose debug folder was pruned says so', async () => {
    const { runId, attempt } = await runOnce()
    writeFileSync(join(debugDir(), runId, attempt, 'requests.ndjson'), '{"method":"GET"}\n')
    const first = await runCli(dir, ['record', '--profile', 'requests', runId], { env: env() })
    assert.equal(first.code, 0, first.stdout + first.stderr)
    rmSync(join(debugDir(), runId), { recursive: true, force: true })
    const again = await runCli(dir, ['record', '--profile', 'requests', runId], { env: env() })
    assert.equal(again.code, 2, again.stdout + again.stderr)
    assert.match(
      again.stderr,
      new RegExp(
        `${runId} is already recorded with different content \\(its debug data differs: \\.reeval/debug/${runId} was pruned or changed since it was recorded`,
      ),
    )
    assert.doesNotMatch(again.stderr, /--artifacts/)
  })

  test("'all' uploads debug.log too", async () => {
    const { runId, attempt } = await runOnce()
    const r = await runCli(dir, ['record', '--profile', 'all', runId], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(uploaded(runId).includes(`${attempt}/debug.log`), uploaded(runId).join(', '))
    assert.equal(recordIn(runId).debug?.level, 'all')
  })

  test("reeval sync --debug downloads one run's debug data on another machine, checked", async () => {
    const { runId, attempt } = await runOnce()
    const lines = '{"method":"POST","url":"https://api.example.com/v1/responses"}\n'
    writeFileSync(join(debugDir(), runId, attempt, 'requests.ndjson'), lines)
    const r = await runCli(dir, ['record', '--profile', 'requests', runId], { env: env() })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const other = await project('store-debug-other', {
      'reeval.config.ts': readFileSync(join(dir, 'reeval.config.ts'), 'utf8'),
    })
    const local = join(other.dir, '.reeval/debug', runId, attempt, 'requests.ndjson')
    const sync = (...args: string[]) =>
      runCli(other.dir, ['sync', '--profile', 'requests', ...args], { env: env() })
    const pulled = await sync()
    assert.equal(pulled.code, 0, pulled.stdout + pulled.stderr)
    assert.equal(existsSync(join(other.dir, '.reeval/debug')), false, 'a pull downloads none')
    const got = await sync('--debug', runId)
    assert.equal(got.code, 0, got.stdout + got.stderr)
    assert.match(
      got.stdout,
      new RegExp(
        `^downloaded 1 debug file of ${runId} \\([\\d.]+ KB\\) into \\.reeval/debug/${runId}$`,
        'm',
      ),
    )
    assert.equal(readFileSync(local, 'utf8'), lines)
    const again = await sync('--debug', runId)
    assert.match(
      again.stdout,
      new RegExp(`^${runId}'s debug data is already in \\.reeval/debug/${runId}$`, 'm'),
    )

    rmSync(join(other.dir, '.reeval/debug'), { recursive: true })
    const key = `dbg/debug/${month(runId)}/${runId}/${attempt}/requests.ndjson`
    const object = s3.objects.get(key) as { bytes: Buffer; etag: string }
    s3.objects.set(key, { ...object, bytes: Buffer.from('{"tampered":true}\n') })
    const tampered = await sync('--debug', runId)
    s3.objects.set(key, object)
    assert.equal(tampered.code, 3, tampered.stdout + tampered.stderr)
    assert.match(
      tampered.stderr,
      /debug\/\S+requests\.ndjson in s3:\/\/reeval-runs\/dbg doesn't match the hash in its record/,
    )
    assert.equal(existsSync(local), false)

    const unrecorded = await runOnce()
    const here = await runCli(dir, ['sync', '--profile', 'requests', '--debug', unrecorded.runId], {
      env: env(),
    })
    assert.equal(here.code, 0, here.stdout + here.stderr)
    assert.match(
      here.stdout,
      /isn't in s3:\/\/reeval-runs\/dbg: it ran here, so its debug data is in \.reeval\/debug\//,
    )
    const bare = await sync(runId)
    assert.notEqual(bare.code, 0)
    assert.match(bare.stderr, /reeval sync takes runs with --debug only/)
  })

  test('a run that failed to upload keeps its debug data for reeval sync', async () => {
    const { runId, attempt } = await runOnce()
    writeFileSync(join(debugDir(), runId, attempt, 'requests.ndjson'), '{"n":1}\n')
    s3.failNext(100)
    const r = await runCli(dir, ['record', '--profile', 'requests', runId], { env: env() })
    s3.failNext(0)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    rmSync(join(debugDir(), runId), { recursive: true })
    const synced = await runCli(dir, ['sync', '--profile', 'requests'], { env: env() })
    assert.equal(synced.code, 0, synced.stdout + synced.stderr)
    assert.deepEqual(uploaded(runId), [`${attempt}/requests.ndjson`])
    assert.equal(existsSync(join(storeDir(), 'debug', runId)), false)
  })
})

test("a network failure is retried on Node's fetch and on Bun's", () => {
  const node = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
  })
  const bun = (code: string, message: string) => Object.assign(new TypeError(message), { code })
  assert.equal(transient(node), true)
  assert.equal(
    transient(
      bun(
        'ECONNREFUSED',
        'ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
      ),
    ),
    true,
  )
  assert.equal(
    transient(bun('ECONNRESET', 'ECONNRESET: The socket connection was closed unexpectedly.')),
    true,
  )
  assert.equal(transient(bun('ENOTFOUND', 'getaddrinfo ENOTFOUND nonexistent.invalid')), true)
  assert.equal(
    transient(Object.assign(new Error('Service Unavailable'), { statusCode: 503 })),
    true,
  )
  assert.equal(transient(Object.assign(new Error('Forbidden'), { statusCode: 403 })), false)
  assert.equal(transient(new TypeError("Cannot read properties of undefined (reading 'x')")), false)
  assert.equal(transient(Object.assign(new Error('boom'), { code: 'ECONNRESET' })), false)
})

describe('a canceled run with --record', { skip: noSignals }, () => {
  let s3: FakeS3
  let dir: string
  let started: string
  before(async () => {
    s3 = await fakeS3()
    started = join(tempDir('store-signal-flag'), 'started')
    const p = await project('store-signal', {
      'reeval.config.ts': fakeConfig({
        extra: `profiles: {
    ci: { history: { store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}' } } },
  },`,
      }),
      'evals/slow.eval.ts': `import { writeFileSync } from 'node:fs'
import { evaluate } from 'reeval'
evaluate('slow', async (c) => {
  writeFileSync(${JSON.stringify(started)}, '')
  await new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)))
})
`,
    })
    dir = p.dir
  })
  after(() => s3.close())

  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    test(`exits ${code} after ${signal}, not the store's 3, and uploads nothing`, async () => {
      rmSync(started, { force: true })
      s3.failNext(100, 503)
      let pid = 0
      const run = runCli(dir, ['run', '--profile', 'ci', '--record'], {
        env: { ...keyEnv(s3), CI: 'false', GITHUB_ACTIONS: 'false' },
        onOutput: (_, id) => {
          pid = id
          return true
        },
      })
      while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 50))
      process.kill(pid, signal)
      const r = await run
      s3.failNext(0)
      assert.equal(r.code, code, r.stdout + r.stderr)
      assert.ok(![...s3.objects.keys()].some((k) => k.startsWith('runs/')))
    })
  }
})
