// `reeval cloud push` against a fake platform that takes a run's history archive and answers how
// reading it stands, as the platform's studio routes do, and refuses as they do.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { MANIFEST_FILE, openArchive } from '../src/archive/index.ts'
import { bufferSource } from '../src/archive/zip.ts'
import { baseEnv, fakeConfig, project, runCli, tempDir } from './helpers.ts'
import { type FakeS3, fakeS3 } from './support/fake-s3.ts'

const TOKEN = 'cli-session-token-0123'
const HISTORY = 'evals/.history'
const SECRET = `ghp_${'a1B2c3D4e5'.repeat(4)}`

type Seen = {
  method: string
  path: string
  auth?: string
  type?: string
  length?: string
  body: Buffer
}

/** What one status poll gets before the final answer: a state, a status code, junk or a reset. */
type Poll = 'pending' | 503 | 429 | 'junk' | 'reset'

type Answer =
  | { status: 'ready' | 'failed'; polls?: Poll[]; error?: string }
  | { refuse: 409 | 413 }
  | { redirect: true }

async function platform(answer: Answer) {
  const seen: Seen[] = []
  let polls = 0
  let revision = 0
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message, retryable: status >= 500 } })
  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  let base = ''
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    const body = await read(req)
    seen.push({
      method: req.method ?? '',
      path: url.pathname,
      ...(req.headers.authorization && { auth: req.headers.authorization }),
      ...(req.headers['content-type'] && { type: req.headers['content-type'] }),
      ...(req.headers['content-length'] && { length: req.headers['content-length'] }),
      body,
    })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return fail(res, 401, 'unauthorized', 'Sign in first.')
    }
    const m = /^\/api\/orgs\/org_a\/projects\/proj_a\/studio\/runs\/([^/]+)$/.exec(url.pathname)
    if (!m) return fail(res, 404, 'not_found', `no route ${url.pathname}`)
    const runId = decodeURIComponent(m[1] as string)
    const state = (status: string, error: string | null = null) => ({
      runId,
      revision,
      status,
      error,
      viewVersion: status === 'ready' ? 1 : null,
    })
    if (req.method === 'PUT') {
      if ('redirect' in answer) {
        res.writeHead(307, { location: `${base}/elsewhere` })
        return res.end()
      }
      if ('refuse' in answer && answer.refuse === 413) {
        return fail(res, 413, 'payload_too_large', 'That archive is too large.')
      }
      if ('refuse' in answer) {
        return fail(res, 409, 'conflict', `Run ${runId} was uploaded to another project.`)
      }
      revision++
      return json(res, 202, state('pending'))
    }
    if (req.method === 'GET' && 'status' in answer) {
      const poll = answer.polls?.[polls++]
      if (poll === 'reset') return void req.socket.destroy()
      if (poll === 503) return fail(res, 503, 'unavailable', 'Try again shortly.')
      if (poll === 429) return fail(res, 429, 'rate_limited', 'Slow down.')
      if (poll === 'junk') return json(res, 200, 'not a state')
      if (poll === 'pending') return json(res, 200, state('pending'))
      return json(res, 200, state(answer.status, answer.error ?? null))
    }
    fail(res, 405, 'invalid_request', 'No.')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const GIT_ENV = {
  ...baseEnv,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

const EVAL = `import { evaluate, expect } from 'reeval'
evaluate('agent', async (c) => {
  await c.send('write hello.txt')
  await expect(c.exec('cat hello.txt')).toSucceed()
})
`

/** A git project linked to `org_a`/`proj_a` on the fake harness. */
async function linkedProject(name: string, extra = '') {
  const p = await project(name, {
    '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
    'reeval.config.ts': fakeConfig({ harness: `{ files: { 'hello.txt': 'hi\\n' } }`, extra }),
    'evals/agent.eval.ts': EVAL,
    '.reeval/project.json': JSON.stringify({ orgId: 'org_a', projectId: 'proj_a' }),
  })
  sh(p.dir, 'init', '-q', '-b', 'main')
  sh(p.dir, 'add', '-A')
  sh(p.dir, 'commit', '-q', '-m', 'init')
  return p.dir
}

let tmp = ''
const envFor = (base: string, token: string | null = TOKEN) => {
  tmp = tempDir('cloud-push-tmp')
  return {
    REEVAL_CLOUD_URL: base,
    ...(token && { REEVAL_TOKEN: token }),
    XDG_CONFIG_HOME: tempDir('cloud-push-config'),
    REEVAL_NO_KEYCHAIN: '1',
    TMPDIR: tmp,
  } as NodeJS.ProcessEnv
}

const pushTemps = () => readdirSync(tmp).filter((f) => f.startsWith('reeval-push-'))

const never = (text: string) => assert.ok(!text.includes(TOKEN), `no token printed: ${text}`)
const noSecret = (text: string) => {
  for (const part of [SECRET, SECRET.slice(4, 14), SECRET.slice(-4)]) {
    assert.ok(!text.includes(part), `no part of the secret printed: ${text}`)
  }
}

describe('reeval cloud push', () => {
  let dir = ''
  let runId = ''
  const path = () => `/api/orgs/org_a/projects/proj_a/studio/runs/${runId}`
  /** Runs `fn` with `name` in the recorded run's folder, then removes it. */
  const withFile = async (name: string, data: string | Buffer, fn: () => Promise<void>) => {
    const file = join(dir, HISTORY, runId, name)
    writeFileSync(file, data)
    try {
      await fn()
    } finally {
      rmSync(file)
    }
  }
  before(async () => {
    dir = await linkedProject('cloud-push')
    const run = await runCli(dir, ['run', '--record'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const records = readdirSync(join(dir, HISTORY)).filter((f) => f.endsWith('.json'))
    runId = (records[0] as string).replace(/\.json$/, '')
  })

  test('uploads the run as its history archive, waits until it is read and prints the studio URL', async () => {
    const p = await platform({ status: 'ready', polls: ['pending', 'pending'] })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`^Pushing ${runId}: \\d+ files, [\\d.]+ KB$`, 'm'))
      assert.match(r.stdout, /^Uploaded revision 1; waiting for the cloud platform to read it$/m)
      assert.ok(
        r.stdout.trimEnd().endsWith(`Ready: ${p.base}/studio?run=${runId}`),
        `ends with the studio URL:\n${r.stdout}`,
      )
      assert.equal(r.stderr, '')
      never(r.stdout + r.stderr)
      assert.deepEqual(
        p.seen.map((s) => `${s.method} ${s.path}`),
        [`PUT ${path()}`, `GET ${path()}`, `GET ${path()}`, `GET ${path()}`],
      )
      const put = p.seen[0] as Seen
      assert.equal(put.auth, `Bearer ${TOKEN}`)
      assert.equal(put.type, 'application/zip')
      assert.equal(put.length, String(put.body.length))
      const archive = await openArchive(bufferSource(put.body))
      assert.equal(archive.manifest.contents, 'run')
      assert.equal(archive.manifest.runId, runId)
      assert.ok(archive.has(`${runId}.json`))
      assert.ok(archive.manifest.files.some((f) => f.path === `${runId}/summary.md`))
      assert.ok(!archive.has(MANIFEST_FILE), 'the manifest is not one of its own files')
      await archive.verify()
      await archive.close()
      assert.deepEqual(pushTemps(), [], 'the archive is removed once uploaded')
    } finally {
      await p.close()
    }
  })

  test('--no-wait returns once the run is uploaded', async () => {
    const p = await platform({ status: 'ready', polls: ['pending'] })
    try {
      const r = await runCli(dir, ['cloud', 'push', runId, '--no-wait'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(
        r.stdout,
        new RegExp(
          `^Uploaded revision 1; the studio shows it once it's read: .*/studio\\?run=${runId}$`,
          'm',
        ),
      )
      assert.deepEqual(
        p.seen.map((s) => s.method),
        ['PUT'],
      )
    } finally {
      await p.close()
    }
  })

  test('status checks ride out a 503, a 429 and a dropped connection', async () => {
    const p = await platform({ status: 'ready', polls: [503, 429, 'reset'] })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /^Ready: /m)
      assert.equal(p.seen.filter((s) => s.method === 'GET').length, 4)
    } finally {
      await p.close()
    }
  })

  test('a status answer that is not one exits 3, naming it', async () => {
    const p = await platform({ status: 'ready', polls: ['junk'] })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /answered how run .* stands with something else/)
      assert.doesNotMatch(r.stderr, /TypeError|at /)
    } finally {
      await p.close()
    }
  })

  test('a run the platform fails to read exits 3 with its error', async () => {
    const p = await platform({
      status: 'failed',
      polls: ['pending'],
      error: 'The archive is run x, not y.',
    })
    try {
      const r = await runCli(dir, ['cloud', 'push', runId], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        new RegExp(
          `reeval: the cloud platform couldn't read run ${runId}: The archive is run x, not y\\.`,
        ),
      )
      assert.doesNotMatch(r.stdout, /Ready/)
      never(r.stdout + r.stderr)
    } finally {
      await p.close()
    }
  })

  test('a run id another project has and an archive too large are refused with exit 2', async () => {
    for (const [status, said] of [
      [409, /refused to upload run .*: Run .* was uploaded to another project\./],
      [413, /refused to upload run .*: That archive is too large\./],
    ] as const) {
      const p = await platform({ refuse: status })
      try {
        const env = envFor(p.base)
        const r = await runCli(dir, ['cloud', 'push'], { env })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, said)
        assert.deepEqual(
          p.seen.map((s) => s.method),
          ['PUT'],
        )
        assert.deepEqual(pushTemps(), [], 'no archive is left behind')
        never(r.stdout + r.stderr)
      } finally {
        await p.close()
      }
    }
  })

  test('a redirected upload is refused and followed nowhere', async () => {
    const p = await platform({ redirect: true })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /redirected the request to the upload elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL/,
      )
      assert.deepEqual(
        p.seen.map((s) => s.path),
        [path()],
      )
    } finally {
      await p.close()
    }
  })

  test('signed out, it says how to sign in and sends nothing', async () => {
    const p = await platform({ status: 'ready' })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base, null) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /reeval cloud push needs you signed in: reeval login signs in, or set REEVAL_TOKEN/,
      )
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })

  test('a refused token names the fix, never the token', async () => {
    const p = await platform({ status: 'ready' })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base, 'stale-token-4567') })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /refused to upload run .*: Sign in first\. \(check REEVAL_TOKEN\)/)
      assert.ok(!(r.stdout + r.stderr).includes('stale-token-4567'))
    } finally {
      await p.close()
    }
  })

  const refused = async (name: string, data: string | Buffer, said: RegExp) => {
    const p = await platform({ status: 'ready' })
    try {
      await withFile(name, data, async () => {
        const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, new RegExp(`Refusing to push ${runId}: `))
        assert.match(r.stderr, said)
        assert.match(r.stderr, /pass --skip-secret-scan to push anyway/)
        noSecret(r.stdout + r.stderr)
        assert.deepEqual(p.seen, [], 'nothing is sent')
      })
    } finally {
      await p.close()
    }
  }

  test('a text file that looks like it holds a secret stops the push before anything is sent', () =>
    refused(
      'notes.txt',
      `first line\nGITHUB_TOKEN=${SECRET}\n`,
      new RegExp(
        `1 file looks like it holds a secret:\\n  ${runId}/notes\\.txt: line 2: GitHub token`,
      ),
    ))

  test('a binary file with NULs is scanned too', () =>
    refused(
      'blob.log',
      Buffer.concat([Buffer.from([0, 1, 2, 0, 255]), Buffer.from(`\nGITHUB_TOKEN=${SECRET}\n`)]),
      new RegExp(`  ${runId}/blob\\.log: line 2: GitHub token`),
    ))

  test('a UTF-16 file is scanned as UTF-16, with or without a byte-order mark', async () => {
    await refused(
      'notes16.txt',
      Buffer.from(`first\nGITHUB_TOKEN=${SECRET}\n`, 'utf16le'),
      new RegExp(`  ${runId}/notes16\\.txt: line 2: GitHub token`),
    )
    await refused(
      'bom16.txt',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`GITHUB_TOKEN=${SECRET}`, 'utf16le')]),
      new RegExp(`  ${runId}/bom16\\.txt: line 1: GitHub token`),
    )
  })

  test('a gzip file is unpacked and scanned', () =>
    refused(
      'out.log.gz',
      gzipSync(`ok\nGITHUB_TOKEN=${SECRET}\n`),
      new RegExp(`  ${runId}/out\\.log\\.gz!: line 2: GitHub token`),
    ))

  test('a file compressed in a format the scan cannot read is refused, naming it', () =>
    refused(
      'trace.tar.xz',
      Buffer.from('not readable here'),
      new RegExp(
        `the secret scan can't read 1 file:\\n  ${runId}/trace\\.tar\\.xz \\(xz-compressed\\)`,
      ),
    ))

  test("a file's name is scanned, and only its folder is shown", () =>
    refused(`${SECRET}.bin`, 'harmless', new RegExp(`  a file name in ${runId}: GitHub token`)))

  test('--skip-secret-scan uploads anyway, printing what the scan found', async () => {
    const p = await platform({ status: 'ready' })
    try {
      await withFile('notes.txt', `GITHUB_TOKEN=${SECRET}\n`, async () => {
        const r = await runCli(dir, ['cloud', 'push', '--skip-secret-scan', '--no-wait'], {
          env: envFor(p.base),
        })
        assert.equal(r.code, 0, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          new RegExp(
            `Pushing ${runId} despite what looks like a secret in:\\n  ${runId}/notes\\.txt: line 1: GitHub token`,
          ),
        )
        noSecret(r.stdout + r.stderr)
        assert.deepEqual(
          p.seen.map((s) => s.method),
          ['PUT'],
        )
      })
    } finally {
      await p.close()
    }
  })

  test('a file name an archive cannot hold is refused cleanly', async () => {
    const p = await platform({ status: 'ready' })
    try {
      await withFile('back\\slash.txt', 'fine', async () => {
        const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          new RegExp(
            `${runId} has a file whose name can't go in an archive: ".*back\\\\\\\\slash\\.txt"`,
          ),
        )
        assert.deepEqual(p.seen, [])
      })
    } finally {
      await p.close()
    }
  })

  test('a run another process is recording is refused until it finishes', async () => {
    const p = await platform({ status: 'ready' })
    const claim = join(dir, HISTORY, `.tmp-${runId}.claim`)
    writeFileSync(claim, `${process.pid}\n${hostname()}\nabc\n`)
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /is being recorded by another process right now/)
      assert.deepEqual(p.seen, [])
    } finally {
      rmSync(claim)
      await p.close()
    }
  })

  test('the newest run, or one named, only in .reeval/runs is refused with how to record it', async () => {
    const p = await platform({ status: 'ready' })
    try {
      const run = await runCli(dir, ['run'])
      assert.equal(run.code, 0, run.stdout + run.stderr)
      const scratch = readdirSync(join(dir, '.reeval/runs'))
        .filter((f) => f.endsWith('.json') && f !== `${runId}.json`)
        .map((f) => f.replace(/\.json$/, ''))
      assert.equal(scratch.length, 1)
      for (const args of [[], [scratch[0] as string]]) {
        const r = await runCli(dir, ['cloud', 'push', ...args], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          new RegExp(`Run ${scratch[0]} isn't recorded: reeval record ${scratch[0]} records it`),
        )
      }
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })
})

describe('reeval cloud push from a remote history store', () => {
  let s3: FakeS3
  let dir = ''
  before(async () => {
    s3 = await fakeS3()
    dir = await linkedProject(
      'cloud-push-store',
      `profiles: {
    ci: { history: { store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}', prefix: 'ci' } } },
  },`,
    )
  })
  after(() => s3.close())

  test('pulls the store before reading it, unless --offline', async () => {
    const keys = {
      AWS_ACCESS_KEY_ID: s3.accessKey,
      AWS_SECRET_ACCESS_KEY: s3.secretKey,
      CI: 'false',
      GITHUB_ACTIONS: 'false',
    }
    const run = await runCli(dir, ['run', '--profile', 'ci', '--record'], { env: keys })
    assert.equal(run.code, 0, run.stdout + run.stderr)
    rmSync(join(dir, '.reeval/store'), { recursive: true, force: true })
    rmSync(join(dir, '.reeval/runs'), { recursive: true, force: true })
    const p = await platform({ status: 'ready' })
    try {
      const env = { ...envFor(p.base), ...keys }
      const offline = await runCli(dir, ['cloud', 'push', '--profile', 'ci', '--offline'], { env })
      assert.equal(offline.code, 2, offline.stdout + offline.stderr)
      assert.deepEqual(p.seen, [])
      const r = await runCli(dir, ['cloud', 'push', '--profile', 'ci', '--no-wait'], { env })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /^Pushing \S+: \d+ files/m)
      assert.deepEqual(
        p.seen.map((s) => s.method),
        ['PUT'],
      )
    } finally {
      await p.close()
    }
  })
})
