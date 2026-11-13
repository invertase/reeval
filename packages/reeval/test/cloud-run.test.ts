// `reeval run` on the cloud platform: a fake platform takes the bundle, runs it with
// `reeval run --bundle` as the platform's machine would, and serves its event stream, which the
// cloud run follows to the run's exit code.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { type TarEntry, writeTar } from '@reeval/sandbox-docker'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { checkCloudSecrets, cloudUrl } from '../src/cloud-run.ts'
import { stripCredentials } from '../src/redact.ts'
import { pkgRoot, project, runCli, tempDir } from './helpers.ts'
import { fakeS3 } from './support/fake-s3.ts'

describe('the cloud platform URL', () => {
  test('an unset REEVAL_CLOUD_URL is https://cloud.reeval.ai, and an explicit one wins', () => {
    assert.equal(cloudUrl({}).href, 'https://cloud.reeval.ai/')
    assert.equal(cloudUrl({ REEVAL_CLOUD_URL: '' }).href, 'https://cloud.reeval.ai/')
    assert.equal(cloudUrl({ REEVAL_CLOUD_URL: '   ' }).href, 'https://cloud.reeval.ai/')
    assert.equal(cloudUrl({ REEVAL_CLOUD_URL: 'http://127.0.0.1:9' }).href, 'http://127.0.0.1:9/')
    assert.equal(
      cloudUrl({ REEVAL_CLOUD_URL: 'https://platform.test/api' }).href,
      'https://platform.test/api/',
    )
  })

  test('a value that is not an http(s) URL, or that carries userinfo, is a usage error', () => {
    assert.throws(
      () => cloudUrl({ REEVAL_CLOUD_URL: 'ftp://platform.test' }),
      /REEVAL_CLOUD_URL is an http or https URL \(got ftp:\/\/platform\.test\)/,
    )
    assert.throws(
      () => cloudUrl({ REEVAL_CLOUD_URL: 'not-a-url' }),
      /REEVAL_CLOUD_URL is an http or https URL \(got not-a-url\)/,
    )
    assert.throws(
      () => cloudUrl({ REEVAL_CLOUD_URL: 'https://u:secret@platform.test' }),
      (error: Error) =>
        /can't carry a user name or password/.test(error.message) &&
        !error.message.includes('secret@'),
    )
    assert.throws(
      () => cloudUrl({ REEVAL_CLOUD_URL: 'https://u:sec@ret@platform.test' }),
      (error: Error) =>
        /got https:\/\/platform\.test\)/.test(error.message) &&
        !error.message.includes('ret') &&
        !error.message.includes('sec@'),
    )
    assert.throws(
      () => cloudUrl({ REEVAL_CLOUD_URL: 'https://u:secret/extra@platform.test' }),
      (error: Error) =>
        /got https:\/\/platform\.test\)/.test(error.message) &&
        !error.message.includes('secret') &&
        !error.message.includes('extra'),
    )
  })

  test('stripCredentials drops the whole userinfo, including @ or / inside the password', () => {
    assert.equal(stripCredentials('https://u:secret@platform.test'), 'https://platform.test')
    assert.equal(stripCredentials('https://u:sec@ret@platform.test'), 'https://platform.test')
    assert.equal(stripCredentials('https://u:secret/extra@platform.test'), 'https://platform.test')
    assert.equal(
      stripCredentials('https://deploy:secret@github.com/acme/skills.git'),
      'https://github.com/acme/skills.git',
    )
    assert.equal(stripCredentials('https://host/path@foo'), 'https://host/path@foo')
    assert.equal(
      stripCredentials('https://example.com:443/path@foo'),
      'https://example.com:443/path@foo',
    )
    assert.equal(stripCredentials('https://u:hunter2@relay.test/e'), 'https://relay.test/e')
  })
})

const TOKEN = 'cloud-check-token-value'

/** The fixture project, unlinked. */
async function unlinkedFixture(answer = '42') {
  const p = await project('cloud', {})
  cpSync(join(pkgRoot, 'test/fixtures/bundle'), p.dir, { recursive: true })
  writeFileSync(join(p.dir, '.env'), `CHECK_TOKEN=${TOKEN}\n`)
  writeFileSync(join(p.dir, 'data/answer.txt'), `${answer}\n`)
  return p.dir
}

/** The fixture project, linked to `proj_a` in `org_a`, as every cloud run's project is. */
async function fixtureProject(answer = '42') {
  const dir = await unlinkedFixture(answer)
  mkdirSync(join(dir, '.reeval'), { recursive: true })
  writeFileSync(
    join(dir, '.reeval/project.json'),
    JSON.stringify({ orgId: 'org_a', projectId: 'proj_a' }),
  )
  return dir
}

/** Where the platform's machine extracts a bundle, with `reeval` resolving to this package. */
function extractRoot(): string {
  const dir = tempDir('cloud-tmp')
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(pkgRoot, join(dir, 'node_modules/reeval'), 'dir')
  return dir
}

const bodyOf = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

type Seen = { method: string; path: string; auth: string | undefined }

/**
 * The platform machine's files of the run, from the project root it extracted the bundle into:
 * its `.reeval/runs` and `.reeval/debug` with their directory entries, and the paths the run-end
 * event's `recorded` names, each path once.
 */
function machineFiles(tmp: string, lines: string[]): TarEntry[] {
  const find = (dir: string, depth: number): string | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules') continue
      const path = join(dir, e.name)
      if (e.name === '.reeval') return path
      const found = depth > 0 ? find(path, depth - 1) : null
      if (found) return found
    }
    return null
  }
  const reeval = find(tmp, 4)
  assert.ok(reeval, `no .reeval under ${tmp}`)
  const root = dirname(reeval)
  const end = lines
    .map((l) => JSON.parse(l) as { type: string; recorded?: Record<string, string | null> })
    .find((e) => e.type === 'run-end')
  const recorded = Object.values(end?.recorded ?? {}).filter(
    (p): p is string => !!p && p !== '.reeval' && !/^\.reeval\/(runs|debug)(\/|$)/.test(p),
  )
  return [
    ...(existsSync(join(reeval, 'runs')) ? readTreeSync(join(reeval, 'runs'), '.reeval/runs') : []),
    ...(existsSync(join(reeval, 'debug'))
      ? readTreeSync(join(reeval, 'debug'), '.reeval/debug')
      : []),
    ...recorded.flatMap((path) => {
      const file = join(root, path)
      return statSync(file).isDirectory()
        ? readTreeSync(file, path)
        : [{ type: 'file' as const, path, mode: 0o644, mtime: 0, data: readFileSync(file) }]
    }),
  ]
}

function readTreeSync(dir: string, prefix: string): TarEntry[] {
  const out: TarEntry[] = [{ type: 'dir', path: prefix, mode: 0o755, mtime: 0 }]
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    const at = `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...readTreeSync(path, at))
    else if (e.isSymbolicLink()) {
      out.push({ type: 'symlink', path: at, mode: 0o777, mtime: 0, target: readlinkSync(path) })
    } else out.push({ type: 'file', path: at, mode: 0o644, mtime: 0, data: readFileSync(path) })
  }
  return out
}

/** What the fake platform serves as a run's files: the machine's, changed, or none (404). */
type FilesOf = (machine: TarEntry[]) => TarEntry[] | null

/**
 * The platform's API as the cloud run uses it: create, upload, start, the run's status and its
 * event socket. Starting runs the bundle with `reeval run --bundle --events-url`, posting to this
 * server, which numbers the lines and relays them as `{"seq":n,"line":…}` frames. With `fails`,
 * starting runs nothing: the socket closes with no exit line and the run reads as failed, with
 * `exitCode` when given. With `holds`, starting sends a header and a `held` notice and the run
 * goes on until it's canceled; with `stops`, it ends with `exitCode` (130 when not given) and
 * reads as stopped, for that reason. `status` and `error` replace what the run reads as (and a
 * cancel then finds it ended), and with `slowStatus` the run's status never answers. With
 * `resume`, the run's stream already holds a stopped run, and resuming it answers each of
 * `resume` in turn (then 202): a 200 or 202 relays the resumed run's lines, ending with
 * `resumedCode`; with `resumeEnds`, it relays nothing and the run reads as that status, for that
 * reason.
 */
async function platform(
  options: {
    fails?: string
    exitCode?: number
    env?: Record<string, string>
    /**
     * The linked project's secret names; the status the route answers; a body without them
     * (`malformed`) or a dropped connection (`drop`). No route when unset.
     */
    secretNames?: string[] | number | 'malformed' | 'drop'
    /** The asked-for names the fake platform reserves. */
    reserved?: string[]
    holds?: boolean
    stops?: string
    status?: unknown
    error?: unknown
    slowStatus?: boolean
    resume?: Array<{ status: number; code?: string; message?: string; retryAfter?: string }>
    resumedCode?: number
    resumeEnds?: { status: 'failed' | 'stopped'; message: string }
  } = {},
) {
  const seen: Seen[] = []
  const tmp = extractRoot()
  let files: FilesOf = (machine) => machine
  const lines: string[] = []
  const viewers = new Set<WebSocket>()
  let declared: { bundleSha256?: string; bundleBytes?: number } = {}
  let uploaded: Buffer | undefined
  let over = false
  let vm: ReturnType<typeof runCli> | undefined
  const finish = () => {
    over = true
    for (const v of viewers) v.close(1000)
  }
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  let canceled = false
  let resumed = false
  const resumeAnswers = [...(options.resume ?? [])]
  const resumeBodies: unknown[] = []
  const stops = options.stops ?? (options.resume ? 'The run was stopped by the platform.' : '')
  const run = () => ({
    id: 'run_1',
    segment: resumed ? 1 : 0,
    lastSeq: lines.length,
    status: resumed
      ? options.resumeEnds
        ? options.resumeEnds.status
        : over
          ? 'succeeded'
          : 'running'
      : options.fails
        ? 'failed'
        : stops
          ? 'stopped'
          : canceled
            ? over
              ? 'cancelled'
              : 'running'
            : over
              ? 'succeeded'
              : 'running',
    error: resumed
      ? options.resumeEnds
        ? { code: 'resume_failed', message: options.resumeEnds.message }
        : null
      : options.fails
        ? { code: 'start_failed', message: options.fails }
        : stops
          ? { code: 'stopped_by_platform', message: stops }
          : null,
    exitCode:
      resumed && !options.resumeEnds ? (options.resumedCode ?? 0) : (options.exitCode ?? null),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.error === undefined ? {} : { error: options.error }),
  })
  const relay = (line: object) => {
    const l = JSON.stringify(line)
    lines.push(l)
    for (const v of viewers) v.send(`{"seq":${lines.length},"line":${l}}`)
  }
  const header = () =>
    relay({
      type: 'header',
      schemaVersion: 1,
      reeval: '0.0.0',
      runId: 'r-held',
      startedAt: new Date().toISOString(),
      pid: 1,
      host: 'platform-machine',
      harness: 'fake',
      verbosity: 0,
    })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    seen.push({ method: req.method ?? '', path: url.pathname, auth: req.headers.authorization })
    const body = await bodyOf(req)
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { gatewayBaseUrl: null })
    }
    if (
      req.method === 'GET' &&
      url.pathname === '/api/orgs/org_a/projects/proj_a/secret-names' &&
      options.secretNames !== undefined
    ) {
      const names = options.secretNames
      if (names === 'drop') return req.socket.destroy()
      if (names === 'malformed') return json(res, 200, { names: 'CHECK_TOKEN' })
      if (typeof names === 'number') {
        return json(res, names, { error: { code: 'internal', message: 'down' } })
      }
      const asked = url.searchParams.get('reserved')?.split(',') ?? []
      const reserved = asked.filter((n) => options.reserved?.includes(n))
      return json(res, 200, { names, reserved })
    }
    if (req.method === 'GET' && url.pathname === '/api/orgs/org_a/projects') {
      return json(res, 200, { projects: [{ id: 'proj_a', slug: 'main', name: 'Main' }] })
    }
    if (req.method === 'POST' && url.pathname === '/api/orgs/org_a/projects/proj_a/runs') {
      declared = JSON.parse(body.toString())
      return json(res, 201, {
        runId: 'run_1',
        status: 'created',
        upload: { url: `${base}/api/runs/run_1/bundle`, method: 'PUT' },
      })
    }
    if (req.method === 'PUT' && url.pathname === '/api/runs/run_1/bundle') {
      assert.equal(req.headers['content-type'], 'application/gzip')
      uploaded = body
      return json(res, 200, run())
    }
    if (req.method === 'POST' && url.pathname === '/api/runs/run_1/start') {
      if (!uploaded) return json(res, 409, { error: { code: 'no_bundle', message: 'no bundle' } })
      if (options.fails) {
        over = true
      } else if (options.holds) {
        header()
        relay({ type: 'notice', at: Date.now(), level: 'info', text: 'held' })
      } else if (options.stops) {
        header()
        relay({ type: 'exit', at: Date.now(), code: options.exitCode ?? 130 })
        over = true
      } else {
        const file = join(tempDir('cloud-bundle'), 'bundle.tar.gz')
        writeFileSync(file, uploaded)
        vm = runCli(
          tempDir('cloud-vm'),
          ['run', '--bundle', file, '--events-url', `${base}/ingest`],
          { env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN, ...options.env } },
        )
      }
      return json(res, 202, run())
    }
    if (req.method === 'GET' && url.pathname === '/api/runs/run_1') {
      if (options.slowStatus) return
      return json(res, 200, run())
    }
    if (req.method === 'POST' && url.pathname === '/api/runs/run_1/resume' && options.resume) {
      resumeBodies.push(JSON.parse(body.toString() || 'null'))
      const next = resumeAnswers.shift() ?? { status: 202 }
      if (next.status !== 200 && next.status !== 202) {
        res.writeHead(next.status, {
          'content-type': 'application/json',
          ...(next.retryAfter === undefined ? {} : { 'retry-after': next.retryAfter }),
        })
        return res.end(JSON.stringify({ error: { code: next.code, message: next.message } }))
      }
      if (!resumed && options.resumeEnds) resumed = true
      if (!resumed) {
        resumed = true
        over = false
        header()
        relay({ type: 'notice', at: Date.now(), level: 'info', text: 'resumed' })
        relay({ type: 'exit', at: Date.now(), code: options.resumedCode ?? 0 })
        finish()
      }
      return json(res, next.status, run())
    }
    if (req.method === 'POST' && url.pathname === '/api/runs/run_1/cancel') {
      if (over || options.status !== undefined) return json(res, 200, run())
      canceled = true
      const answer = run()
      relay({ type: 'exit', at: Date.now(), code: 130 })
      finish()
      return json(res, 202, answer)
    }
    if (req.method === 'GET' && url.pathname === '/api/runs/run_1/artifacts/files.tar.gz') {
      await vm
      const served = vm ? files(machineFiles(tmp, lines)) : null
      if (!served) return json(res, 404, { error: { code: 'not_found', message: 'no files' } })
      res.writeHead(200, { 'content-type': 'application/gzip' })
      return res.end(gzipSync(writeTar(served)))
    }
    if (req.method === 'POST' && url.pathname === '/ingest') {
      for (const l of body.toString().split('\n').filter(Boolean)) {
        lines.push(l)
        for (const v of viewers) v.send(`{"seq":${lines.length},"line":${l}}`)
        if (l.includes('"type":"exit"')) finish()
      }
      return res.end()
    }
    json(res, 404, { error: { code: 'not_found', message: `no route ${url.pathname}` } })
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    seen.push({ method: 'WS', path: url.pathname, auth: req.headers.authorization })
    if (url.pathname !== '/api/runs/run_1/events') return socket.destroy()
    sockets.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      viewers.add(ws)
      ws.on('close', () => viewers.delete(ws))
      const after = Number(url.searchParams.get('after') ?? 0)
      for (let seq = after + 1; seq <= lines.length; seq++) {
        ws.send(`{"seq":${seq},"line":${lines[seq - 1]}}`)
      }
      if (over) ws.close(1000)
    })
  })
  if (options.resume) {
    header()
    relay({ type: 'exit', at: Date.now(), code: 130 })
    over = true
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    resumeBodies,
    get declared() {
      return declared
    },
    get uploaded() {
      return uploaded
    },
    vm: () => vm,
    serve: (f: FilesOf) => {
      files = f
    },
    close: async () => {
      await vm?.catch(() => {})
      for (const v of viewers) v.terminate()
      sockets.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

describe('reeval run on the cloud platform', () => {
  test('bundles, creates, uploads, starts and follows the run, with its exit code', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Running in the cloud \(1 attempt\), --local to run here/)
      assert.match(r.stdout, /Started cloud run run_1/)
      assert.match(r.stdout, /1 passed/)
      assert.deepEqual(
        p.seen.filter((s) => s.path !== '/ingest').map((s) => `${s.method} ${s.path}`),
        [
          'GET /api/config',
          'GET /api/orgs/org_a/projects/proj_a/secret-names',
          'POST /api/orgs/org_a/projects/proj_a/runs',
          'PUT /api/runs/run_1/bundle',
          'POST /api/runs/run_1/start',
          'WS /api/runs/run_1/events',
          'GET /api/runs/run_1',
        ],
      )
      for (const s of p.seen.filter((s) => s.path !== '/ingest')) {
        assert.equal(s.auth, 'Bearer cloud-test-token', `${s.method} ${s.path}`)
      }
      const archive = p.uploaded
      assert.ok(archive)
      assert.deepEqual(p.declared, {
        bundleSha256: createHash('sha256').update(archive).digest('hex'),
        bundleBytes: archive.length,
      })
      assert.ok(!archive.includes(TOKEN), 'no secret value in the bundle')
      const again = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.equal(p.seen.at(-1)?.auth, 'Bearer cloud-test-token', 'reeval attach sends it too')
    } finally {
      await p.close()
    }
  })

  test('refuses an unlinked project before bundling, naming reeval link, with --dry-run too', async () => {
    const p = await platform({ secretNames: ['CHECK_TOKEN'] })
    try {
      const dir = await unlinkedFixture()
      for (const args of [
        ['run', '--cloud'],
        ['run', '--cloud', '--dry-run'],
      ]) {
        const r = await runCli(dir, args, {
          env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
        })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          /A cloud run goes into a linked cloud project, and this project isn't linked: run reeval link --org <org> --project <project> to link it, or pass --local to run here/,
        )
      }
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })

  test('creates the run in the project reeval link linked', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(
        p.seen.filter((s) => s.method === 'POST' && s.path.endsWith('/runs')).map((s) => s.path),
        ['/api/orgs/org_a/projects/proj_a/runs'],
      )
      writeFileSync(
        join(dir, '.reeval/project.json'),
        JSON.stringify({ orgId: 'org_a', projectId: 'proj_gone' }),
      )
      const gone = await runCli(dir, ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(gone.code, 2, gone.stdout + gone.stderr)
      assert.match(
        gone.stderr,
        /refused to create the run in proj_gone, the project reeval link linked: .* \(reeval link links another\)/,
      )
    } finally {
      await p.close()
    }
  })

  test('stops before uploading, naming them, when the linked project lacks a declared secret', async () => {
    const p = await platform({ secretNames: ['AI_GATEWAY_API_KEY', 'OTHER_KEY'] })
    try {
      const dir = await fixtureProject()
      writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${TOKEN}\nFROM_FILE=${TOKEN}-2\n`)
      const r = await runCli(dir, ['run', '--cloud', '--force'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /The cloud project Main \(main\) lacks a secret this run needs, so nothing was uploaded:\n {2}CHECK_TOKEN\nAdd it with reeval cloud secrets set <name> --from-env, /,
      )
      assert.doesNotMatch(r.stderr, /FROM_FILE|sets this name itself/)
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), 'no secret value in the output')
      assert.deepEqual(
        p.seen.map((s) => `${s.method} ${s.path}`),
        [
          'GET /api/config',
          'GET /api/orgs/org_a/projects/proj_a/secret-names',
          'GET /api/orgs/org_a/projects',
        ],
      )
      assert.equal(p.seen[1]?.auth, 'Bearer cloud-test-token')
    } finally {
      await p.close()
    }
  })

  test('says a declared name the platform reserves needs renaming, not setting', async () => {
    const p = await platform({ secretNames: [], reserved: ['CHECK_TOKEN'] })
    try {
      const r = await runCli(await fixtureProject(), ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /nothing was uploaded:\nThe cloud platform sets this name itself, so no cloud run can take it as a secret: rename it in the eval\.\n {2}CHECK_TOKEN/,
      )
      assert.doesNotMatch(r.stderr, /cloud secrets set/)
    } finally {
      await p.close()
    }
  })

  test("notes a reserved name from .env won't be sent, and runs", async () => {
    const p = await platform({ secretNames: ['CHECK_TOKEN'], reserved: ['REEVAL_FROM_FILE'] })
    try {
      const dir = await fixtureProject()
      writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${TOKEN}\nREEVAL_FROM_FILE=${TOKEN}-2\n`)
      const r = await runCli(dir, ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(
        r.stdout,
        /cloud: REEVAL_FROM_FILE \(from \.env\) won't be sent: the cloud platform sets this name itself/,
      )
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), 'no secret value in the output')
      assert.ok(p.seen.some((s) => s.method === 'POST' && s.path.endsWith('/runs')))
    } finally {
      await p.close()
    }
  })

  test('stops with no terminal to ask on when the project lacks names only .env sets, naming --force', async () => {
    const p = await platform({ secretNames: ['CHECK_TOKEN'] })
    try {
      const dir = await fixtureProject()
      writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${TOKEN}\nFOO=${TOKEN}-2\nBAR=${TOKEN}-3\n`)
      const r = await runCli(dir, ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /Cloud environment does not have the following secrets you have locally defined:\n {2}BAR\n {2}FOO\nNothing was uploaded\. Pass --force to run without them, or add each with reeval cloud secrets set <name> --from-env, /,
      )
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), 'no secret value in the output')
      assert.ok(!p.seen.some((s) => s.method === 'POST' && s.path.endsWith('/runs')))
    } finally {
      await p.close()
    }
  })

  test('runs without the names only .env sets with --force, without asking', async () => {
    const p = await platform({ secretNames: ['CHECK_TOKEN'] })
    try {
      const dir = await fixtureProject()
      writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${TOKEN}\nFOO=${TOKEN}-2\n`)
      const r = await runCli(dir, ['run', '--cloud', '--force'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(
        r.stdout,
        /cloud: running without FOO, which only this machine's \.env files set/,
      )
      assert.doesNotMatch(r.stdout + r.stderr, /Do you want to continue/)
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), 'no secret value in the output')
      assert.ok(p.seen.some((s) => s.method === 'POST' && s.path.endsWith('/runs')))
    } finally {
      await p.close()
    }
  })

  test('asks before running without the names only .env sets, and stops on no', async () => {
    const p = await platform({ secretNames: ['CHECK_TOKEN'] })
    try {
      const check = (answer: boolean) => {
        const asked: string[] = []
        const logged: string[] = []
        const done = checkCloudSecrets({
          base: new URL(p.base),
          auth: { headers: { authorization: 'Bearer cloud-test-token' }, refused: '' },
          project: { orgId: 'org_a', projectId: 'proj_a' },
          manifest: {
            secrets: ['CHECK_TOKEN'],
            envFiles: [{ path: '.env', variables: ['CHECK_TOKEN', 'FOO', 'BAR'] }],
          },
          log: (line) => logged.push(line),
          confirm: async (question) => {
            asked.push(question)
            return answer
          },
        })
        return { done, asked, logged }
      }
      const yes = check(true)
      await yes.done
      assert.deepEqual(yes.asked, [
        'Cloud environment does not have the following secrets you have locally defined:\n  BAR\n  FOO\n\nDo you want to continue? [y/N] ',
      ])
      const no = check(false)
      await assert.rejects(no.done, /Stopped: nothing was uploaded\./)
      assert.equal(no.asked.length, 1)
    } finally {
      await p.close()
    }
  })

  test('runs when the linked project has every name the run needs, its .env ones too', async () => {
    const p = await platform({ secretNames: ['CHECK_TOKEN', 'FROM_FILE'] })
    try {
      const dir = await fixtureProject()
      writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${TOKEN}\nFROM_FILE=${TOKEN}-2\n`)
      const r = await runCli(dir, ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(
        p.seen.slice(0, 3).map((s) => `${s.method} ${s.path}`),
        [
          'GET /api/config',
          'GET /api/orgs/org_a/projects/proj_a/secret-names',
          'POST /api/orgs/org_a/projects/proj_a/runs',
        ],
      )
    } finally {
      await p.close()
    }
  })

  test('skips the secrets check, with a debug line, when the platform cannot list the names', async () => {
    const cases = [
      [undefined, /HTTP 404/],
      [500, /HTTP 500/],
      ['malformed', /the answer has no list of names/],
      ['drop', /couldn't list the project's secret names: .* didn't answer/],
    ] as const
    for (const [secretNames, why] of cases) {
      const p = await platform({ secretNames })
      try {
        const r = await runCli(await fixtureProject(), ['run', '--cloud'], {
          env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token', REEVAL_DEBUG: '1' },
        })
        assert.equal(r.code, 0, r.stdout + r.stderr)
        assert.match(r.stderr, new RegExp(`cloud: secrets check skipped: ${why.source}`))
        assert.ok(p.seen.some((s) => s.method === 'POST' && s.path.endsWith('/runs')))
      } finally {
        await p.close()
      }
    }
  })

  test("sends reeval login's token, and REEVAL_TOKEN over it", async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const config = tempDir('cloud-login')
      mkdirSync(join(config, 'reeval'))
      writeFileSync(
        join(config, 'reeval/credentials.json'),
        JSON.stringify({
          schemaVersion: 1,
          logins: {
            [p.base]: {
              store: 'file',
              token: 'stored-login-token',
              user: { email: 'ada@example.com' },
              signedInAt: new Date().toISOString(),
            },
          },
        }),
      )
      const env = { REEVAL_CLOUD_URL: p.base, XDG_CONFIG_HOME: config, REEVAL_NO_KEYCHAIN: '1' }
      const r = await runCli(dir, ['run', '--cloud'], { env })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const calls = p.seen.filter((s) => s.path !== '/ingest')
      assert.ok(calls.some((s) => s.method === 'WS'))
      for (const s of calls) {
        assert.equal(s.auth, 'Bearer stored-login-token', `${s.method} ${s.path}`)
      }
      const attach = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], { env })
      assert.equal(attach.code, 0, attach.stdout + attach.stderr)
      assert.equal(p.seen.at(-1)?.auth, 'Bearer stored-login-token')
      const over = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], {
        env: { ...env, REEVAL_TOKEN: 'ci-token' },
      })
      assert.equal(over.code, 0, over.stdout + over.stderr)
      assert.equal(p.seen.at(-1)?.auth, 'Bearer ci-token')
    } finally {
      await p.close()
    }
  })

  test('a refused token says to sign in with reeval login', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in first.' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const r = await runCli(await fixtureProject(), ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: base, XDG_CONFIG_HOME: tempDir('cloud-login') },
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /refused to read the cloud platform's config: Sign in first\. \(reeval login signs in, or set REEVAL_TOKEN\)/,
      )
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test("exits with the run's exit code when it fails, from the config's cloud: true", async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject('41')
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace('defineConfig({', 'defineConfig({\n  cloud: true,'),
      )
      const r = await runCli(dir, ['run'], { env: { REEVAL_CLOUD_URL: p.base } })
      assert.equal(r.code, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /Running in the cloud/)
      assert.ok(
        p.seen.every((s) => s.auth === undefined),
        'no token, no authorization header',
      )
    } finally {
      await p.close()
    }
  })

  test("a run that fails on the platform before its exit line exits 3 with the platform's reason", async () => {
    const p = await platform({ fails: 'the run could not start' })
    try {
      const r = await runCli(await fixtureProject(), ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base },
      })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /cloud run run_1 failed: the run could not start/)
    } finally {
      await p.close()
    }
  })

  test("a run that ends on the platform before its exit line exits with the platform's code", async () => {
    const p = await platform({ fails: 'the plan differs from the bundle', exitCode: 2 })
    try {
      const r = await runCli(await fixtureProject(), ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base },
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stdout, /cloud run run_1 ended: the plan differs from the bundle/)
    } finally {
      await p.close()
    }
  })

  test('Ctrl-C or SIGTERM without a terminal detaches and the run goes on, from reeval run and reeval attach', async () => {
    for (const signals of [['SIGINT'], ['SIGTERM'], ['SIGINT', 'SIGTERM']] as const) {
      const p = await platform({ holds: true })
      const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
      const interrupt = (stdout: string, pid: number) => {
        if (!stdout.includes('held')) return false
        for (const signal of signals) process.kill(pid, signal)
        return true
      }
      const sent = signals.join(' then ')
      try {
        const dir = await fixtureProject()
        const r = await runCli(dir, ['run', '--cloud'], { env, onOutput: interrupt })
        assert.equal(r.code, 130, `${sent}: ${r.stdout}${r.stderr}`)
        assert.match(
          r.stdout,
          /Cloud run run_1 goes on: reeval attach \S+\/api\/runs\/run_1\/events follows it again; reeval cloud run cancel run_1 cancels it/,
          sent,
        )
        const again = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], {
          env,
          onOutput: interrupt,
        })
        assert.equal(again.code, 0, `${sent}: ${again.stdout}${again.stderr}`)
        assert.match(again.stdout, /Detached from run r-held\./, sent)
        assert.ok(!p.seen.some((s) => s.path.endsWith('/cancel')), 'detaching cancels nothing')
      } finally {
        await p.close()
      }
    }
  })

  test("once the run ends, a status that doesn't come within a few seconds, or a Ctrl-C while waiting for it, keeps the stream's exit code", async () => {
    const p = await platform({ slowStatus: true })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const dir = await fixtureProject()
      let ended = 0
      const r = await runCli(dir, ['run', '--cloud'], {
        env,
        onOutput: (stdout) => {
          if (!/1 passed/.test(stdout)) return false
          ended = Date.now()
          return true
        },
      })
      const waited = Date.now() - ended
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.ok(waited < 15_000, `waited ${waited}ms for the status`)
      let killed = 0
      const interrupted = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], {
        env,
        onOutput: (stdout, pid) => {
          if (!/1 passed/.test(stdout)) return false
          setTimeout(() => {
            killed = Date.now()
            process.kill(pid, 'SIGINT')
          }, 1500)
          return true
        },
      })
      assert.equal(interrupted.code, 0, interrupted.stdout + interrupted.stderr)
      assert.ok(killed > 0 && Date.now() - killed < 3000, 'Ctrl-C ends the wait')
      assert.doesNotMatch(interrupted.stdout + interrupted.stderr, /goes on|reeval:/)
    } finally {
      await p.close()
    }
  })

  test('reeval cloud run cancel cancels the run by its id or event stream URL, and its followers see it end', async () => {
    const p = await platform({ holds: true })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const dir = await fixtureProject()
      let canceling: Promise<Awaited<ReturnType<typeof runCli>>> | undefined
      const followed = await runCli(dir, ['run', '--cloud'], {
        env,
        onOutput: (stdout) => {
          if (!stdout.includes('held')) return false
          canceling = runCli(dir, ['cloud', 'run', 'cancel', 'run_1'], { env })
          return true
        },
      })
      const canceled = await canceling
      assert.equal(canceled?.code, 0, `${canceled?.stdout}${canceled?.stderr}`)
      assert.match(canceled?.stdout ?? '', /Canceling cloud run run_1/)
      assert.equal(followed.code, 130, followed.stdout + followed.stderr)
      assert.doesNotMatch(followed.stdout, /goes on/)
      const cancel = p.seen.find((s) => s.path === '/api/runs/run_1/cancel')
      assert.equal(cancel?.method, 'POST')
      assert.equal(cancel?.auth, 'Bearer cloud-test-token')
      const ended = await runCli(
        dir,
        ['cloud', 'run', 'cancel', `${p.base.replace(/^http/, 'ws')}/api/runs/run_1/events`],
        { env },
      )
      assert.equal(ended.code, 0, ended.stdout + ended.stderr)
      const status = /Cloud run run_1 has already ended \((\w+)\)/.exec(ended.stdout)?.[1]
      assert.equal(status, 'cancelled', ended.stdout)
      const missing = await runCli(dir, ['cloud', 'run', 'cancel', 'run_2'], { env })
      assert.equal(missing.code, 2, missing.stdout + missing.stderr)
      assert.match(missing.stderr, /the cloud platform refused to cancel run run_2/)
      const none = await runCli(dir, ['cloud', 'run', 'cancel'], { env })
      assert.equal(none.code, 2)
      assert.match(none.stderr, /reeval cloud run cancel needs the run/)
      const bare = await runCli(dir, ['cloud', 'run'], { env })
      assert.equal(bare.code, 2)
      assert.match(
        bare.stderr,
        /Unknown command "cloud run"\. Did you mean reeval cloud run cancel/,
      )
      const elsewhere = await runCli(
        dir,
        ['cloud', 'run', 'cancel', 'https://elsewhere.test/api/runs/run_1/events'],
        { env },
      )
      assert.equal(elsewhere.code, 2)
      assert.match(elsewhere.stderr, /isn't a cloud run's event stream at/)
    } finally {
      await p.close()
    }
  })

  test('a run the platform stopped exits 4 with how to resume it, from reeval run and reeval attach, whatever its stream ended with', async () => {
    for (const exitCode of [130, 3, 0]) {
      const p = await platform({ stops: 'The run was stopped by the platform.', exitCode })
      const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
      try {
        const dir = await fixtureProject()
        const r = await runCli(dir, ['run', '--cloud'], { env })
        assert.equal(r.code, 4, `exit ${exitCode}: ${r.stdout}${r.stderr}`)
        assert.match(r.stdout, /Cloud run run_1 stopped: The run was stopped by the platform\./)
        assert.match(r.stdout, /reeval run --cloud --resume run_1 continues it/)
        const again = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], { env })
        assert.equal(again.code, 4, `exit ${exitCode}: ${again.stdout}${again.stderr}`)
        assert.match(again.stdout, /reeval run --cloud --resume run_1 continues it/)
      } finally {
        await p.close()
      }
    }
  })

  test("the platform's text reaches the terminal without escape sequences, and a field that isn't text is left out", async () => {
    const odd = await platform({ stops: 'x', error: { code: 12, message: { said: 'no' } } })
    const env = { REEVAL_CLOUD_URL: odd.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const r = await runCli(await fixtureProject(), ['run', '--cloud'], { env })
      assert.equal(r.code, 4, r.stdout + r.stderr)
      assert.match(r.stdout, /The cloud platform stopped run run_1 before it finished/)
      assert.match(r.stdout, /reeval run --cloud --resume run_1 continues it/)
    } finally {
      await odd.close()
    }
    const escaped = await platform({ status: 'cancel\u001b[2Jled' })
    try {
      const r = await runCli(await fixtureProject(), ['cloud', 'run', 'cancel', 'run_1'], {
        env: { REEVAL_CLOUD_URL: escaped.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Cloud run run_1 has already ended \(cancel\[2Jled\)/)
      assert.ok(!r.stdout.includes('\u001b'), 'no escape reaches the terminal')
    } finally {
      await escaped.close()
    }
  })

  test("reeval attach reads a cloud run's status when its stream is lost, as reeval run --cloud does", async () => {
    const p = await platform({ fails: 'lost', status: 'stopped', exitCode: 130 })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const dir = await fixtureProject()
      for (const args of [
        ['run', '--cloud'],
        ['attach', `${p.base}/api/runs/run_1/events`],
      ]) {
        const r = await runCli(dir, args, { env })
        assert.equal(r.code, 4, `${args[0]}: ${r.stdout}${r.stderr}`)
        assert.match(r.stdout, /Cloud run run_1 stopped: lost/, args[0])
      }
    } finally {
      await p.close()
    }
  })

  test('exit 2 for a REEVAL_CLOUD_URL that is not http(s) or carries userinfo, and for flags a cloud run cannot take', async () => {
    const dir = await fixtureProject()
    const unset = await runCli(dir, ['run', '--cloud', '--dry-run'], {
      env: { REEVAL_CLOUD_URL: '' },
    })
    assert.equal(unset.code, 0, unset.stdout + unset.stderr)
    assert.match(unset.stdout, /target {2}cloud/)
    assert.doesNotMatch(unset.stdout + unset.stderr, /REEVAL_CLOUD_URL isn't set/)
    const bad = await runCli(dir, ['run', '--cloud'], {
      env: { REEVAL_CLOUD_URL: 'ftp://platform.test' },
    })
    assert.equal(bad.code, 2)
    assert.match(
      bad.stderr,
      /REEVAL_CLOUD_URL is an http or https URL \(got ftp:\/\/platform\.test\)/,
    )
    const both = await runCli(dir, ['run', '--cloud', '--local'])
    assert.equal(both.code, 2)
    assert.match(both.stderr, /--cloud and --local pick where the run goes/)
    const local = await runCli(dir, ['run', '--cloud', '--concurrency', '2'], {
      env: { REEVAL_CLOUD_URL: 'http://127.0.0.1:9' },
    })
    assert.equal(local.code, 2)
    assert.match(local.stderr, /--concurrency applies to a run on this machine/)
    const creds = await runCli(dir, ['run', '--cloud'], {
      env: { REEVAL_CLOUD_URL: 'https://u:secret@platform.test' },
    })
    assert.equal(creds.code, 2)
    assert.match(creds.stderr, /can't carry a user name or password/)
    assert.ok(!creds.stderr.includes('secret@'))
    const p = await platform()
    try {
      const token = await runCli(dir, ['run', '--cloud'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'abc\ndef' },
      })
      assert.equal(token.code, 2, token.stdout + token.stderr)
      assert.match(token.stderr, /REEVAL_TOKEN has whitespace or a control character \(U\+000a\)/)
    } finally {
      await p.close()
    }
  })

  test('an unreachable platform exits 3', async () => {
    const p = await platform()
    const base = p.base
    await p.close()
    const r = await runCli(await fixtureProject(), ['run', '--cloud'], {
      env: { REEVAL_CLOUD_URL: base },
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /couldn't read the cloud platform's config/)
  })

  test('a plan the platform cannot run runs here, with a note', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      writeFileSync(
        join(dir, 'evals/mac.eval.ts'),
        `import { defineEnvironment, evaluate } from 'reeval'
import { tart } from 'reeval/sandbox'

const mac = defineEnvironment('mac', {
  sandbox: tart({ image: 'ghcr.io/cirruslabs/macos-sequoia-base:15.6' }),
  egress: 'allow-all',
})
evaluate('on a mac', { environments: mac }, async () => {})
`,
      )
      const r = await runCli(dir, ['run', '--cloud', '--dry-run'], {
        env: { REEVAL_CLOUD_URL: p.base },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /target {2}here, not in the cloud: tart\(\) runs its VMs on a Mac/)
      assert.deepEqual(p.seen, [], 'a dry run never calls the platform')
    } finally {
      await p.close()
    }
  })

  test('a run whose files a bundle cannot carry runs here, with a note', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          '({ skill, secret }) => ({',
          "({ skill, secret, file }) => ({\n    files: { 'notes.txt': file('./notes.txt') },",
        ),
      )
      const host = tempDir('cloud-host')
      writeFileSync(join(host, 'notes.txt'), 'notes\n')
      symlinkSync(join(host, 'notes.txt'), join(dir, 'notes.txt'))
      const r = await runCli(dir, ['run', '--cloud'], { env: { REEVAL_CLOUD_URL: p.base } })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Running here, not in the cloud: .*outside the bundle root/)
      assert.match(r.stdout, /1 passed/)
      assert.deepEqual(p.seen, [], 'a run that stays here never calls the platform')
    } finally {
      await p.close()
    }
  })
})

describe("a cloud run's files, downloaded with --download", () => {
  const env = (p: { base: string }) => ({ REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'files-token' })
  const recordOf = (dir: string) => {
    const name = readdirSync(join(dir, '.reeval/runs')).find((n) => n.endsWith('.json'))
    assert.ok(name, 'a record in .reeval/runs')
    return { runId: name.slice(0, -'.json'.length), file: join(dir, '.reeval/runs', name) }
  }

  test('land in .reeval/runs and .reeval/debug, where show and query read them; again, nothing changes', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud', '--download'], { env: env(p) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const { runId } = recordOf(dir)
      assert.match(
        r.stdout,
        new RegExp(
          `Downloaded run ${runId} of cloud run run_1 into \\.reeval/runs/${runId} \\(\\d+ files, [\\d.]+ KB\\), its debug data in \\.reeval/debug/${runId}; reeval show ${runId} reads it`,
        ),
      )
      const download = p.seen.find((s) => s.path.endsWith('/files.tar.gz'))
      assert.equal(download?.auth, 'Bearer files-token')
      assert.ok(existsSync(join(dir, '.reeval/debug', runId)))
      const show = await runCli(dir, ['show', runId])
      assert.equal(show.code, 0, show.stdout + show.stderr)
      assert.match(show.stdout, new RegExp(`run ${runId} {2}1 pass`))
      const query = await runCli(dir, ['query', 'select run_id from runs'])
      assert.equal(query.code, 0, query.stdout + query.stderr)
      assert.match(query.stdout, new RegExp(runId))
      const again = await runCli(dir, ['attach', '--download', `${p.base}/api/runs/run_1/events`], {
        env: env(p),
      })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.match(again.stdout, new RegExp(`Run ${runId} of cloud run run_1 is already in`))
    } finally {
      await p.close()
    }
  })

  test('never replace a different file, and write nothing then', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud', '--download'], { env: env(p) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const { runId, file } = recordOf(dir)
      const changed = readFileSync(file, 'utf8').replace('"kind"', ' "kind"')
      writeFileSync(file, changed)
      const summary = join(dir, '.reeval/runs', runId, 'summary.md')
      const { rmSync } = await import('node:fs')
      rmSync(summary)
      const clash = await runCli(dir, ['attach', '--download', `${p.base}/api/runs/run_1/events`], {
        env: env(p),
      })
      assert.equal(clash.code, 2, clash.stdout + clash.stderr)
      assert.match(
        clash.stderr,
        new RegExp(
          `Not downloading the files of cloud run run_1: \\.reeval/runs/${runId}\\.json is already here with other content\\. Move it aside to download them \\(cloud run run_1 itself exited with code 0\\)`,
        ),
      )
      assert.equal(readFileSync(file, 'utf8'), changed, 'the record is untouched')
      assert.ok(!existsSync(summary), 'nothing else was written either')
    } finally {
      await p.close()
    }
  })

  test('a run with no files says so and keeps its exit code; one without debug data says that', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject('41')
      p.serve(() => null)
      const none = await runCli(dir, ['run', '--cloud', '--download'], { env: env(p) })
      assert.equal(none.code, 1, none.stdout + none.stderr)
      assert.match(none.stdout, /The cloud platform has no files of run run_1 to download/)
      assert.ok(!existsSync(join(dir, '.reeval/runs')))
      p.serve((machine) =>
        machine.filter(
          (e) => !e.path.startsWith('.reeval/debug') && !e.path.includes('/snapshots'),
        ),
      )
      const partial = await runCli(
        dir,
        ['attach', '--download', `${p.base}/api/runs/run_1/events`],
        {
          env: env(p),
        },
      )
      assert.equal(partial.code, 1, partial.stdout + partial.stderr)
      assert.match(
        partial.stdout,
        /Downloaded run \S+ of cloud run run_1 into .*, without debug data/,
      )
      assert.ok(!existsSync(join(dir, '.reeval/debug')))
      const show = await runCli(dir, ['show', recordOf(dir).runId])
      assert.equal(show.code, 0, show.stdout + show.stderr)
    } finally {
      await p.close()
    }
  })

  test('a recorded run lands in the history folder too, byte for byte as on the machine', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'defineConfig({',
          `defineConfig({
  record: 'always',
  history: { archive: true },
  profiles: { elsewhere: { history: { store: { kind: 'local', dir: './other-history' } } } },`,
        ),
      )
      let served: TarEntry[] = []
      p.serve((machine) => {
        served = machine
        return machine
      })
      const r = await runCli(dir, ['run', '--cloud', '--download'], { env: env(p) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const { runId } = recordOf(dir)
      const history = served.find((e) => e.path.endsWith(`/.history/${runId}.json`))?.path
      assert.ok(history, `the machine recorded the run: ${served.map((e) => e.path).join(', ')}`)
      const folder = history.slice(0, -`/${runId}.json`.length)
      assert.match(
        r.stdout,
        new RegExp(
          `Downloaded run ${runId} of cloud run run_1 into \\.reeval/runs/${runId} \\(\\d+ files, [\\d.]+ KB\\), recorded in ${folder.replaceAll('.', '\\.')}/${runId}\\.json, its debug data in \\.reeval/debug/${runId}; reeval show ${runId} reads it`,
        ),
      )
      assert.ok(served.some((e) => e.type === 'file' && e.path.startsWith('.reeval/debug/')))
      for (const d of ['.reeval/runs', `.reeval/runs/${runId}`, `${folder}/${runId}`]) {
        assert.ok(
          served.some((e) => e.type === 'dir' && e.path === d),
          `a directory entry ${d}`,
        )
      }
      for (const e of served) {
        const here = join(dir, e.path)
        if (e.type === 'file') assert.ok(readFileSync(here).equals(e.data), e.path)
        if (e.type === 'symlink') assert.equal(readlinkSync(here), e.target, e.path)
      }
      assert.ok(existsSync(join(dir, folder, `${runId}.zip`)))
      for (const name of ['.gitignore', '.gitattributes']) {
        assert.ok(existsSync(join(dir, folder, name)), `the history folder's ${name}, as here`)
      }
      assert.ok(existsSync(join(dir, folder, runId, 'summary.md')))
      const listed = await runCli(dir, ['history'])
      assert.equal(listed.code, 0, listed.stdout + listed.stderr)
      assert.match(listed.stdout, new RegExp(runId.slice(0, 15)))
      const events = `${p.base}/api/runs/run_1/events`
      const again = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.match(again.stdout, new RegExp(`Run ${runId} of cloud run run_1 is already in`))
      // A link in a snapshot in the recorded run's folder is kept as one; elsewhere it's refused.
      const attempt = `${folder}/${runId}/evals-answer/fake-cell/1`
      const link = `${attempt}/snapshots/after/AGENTS.md`
      const linkTo = (path: string, target: string): TarEntry => ({
        type: 'symlink',
        path,
        mode: 0o777,
        mtime: 0,
        target,
      })
      p.serve((machine) => [...machine, linkTo(link, 'CLAUDE.md')])
      const linked = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(linked.code, 0, linked.stdout + linked.stderr)
      assert.match(linked.stdout, new RegExp(`recorded in ${folder.replaceAll('.', '\\.')}/`))
      assert.doesNotMatch(linked.stdout, / into \.reeval\/runs/, 'nothing new in .reeval/runs')
      assert.equal(readlinkSync(join(dir, link)), 'CLAUDE.md')
      const outside = tempDir('cloud-outside')
      for (const at of [`${folder}/${runId}/out`, `${attempt}/transcript.jsonl.link`]) {
        p.serve((machine) => [...machine, linkTo(at, outside)])
        const refused = await runCli(dir, ['attach', '--download', events], { env: env(p) })
        assert.equal(refused.code, 3, refused.stdout + refused.stderr)
        assert.match(refused.stderr, /a link outside a snapshot \(/)
        assert.ok(refused.stderr.includes(at), refused.stderr)
        assert.ok(!existsSync(join(dir, at)), `${at}: nothing written`)
      }
      // The recorded copy changed here: nothing is written over it.
      const copy = join(dir, folder, `${runId}.json`)
      const changed = readFileSync(copy, 'utf8').replace('"kind"', ' "kind"')
      writeFileSync(copy, changed)
      p.serve((machine) => machine)
      const clash = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(clash.code, 2, clash.stdout + clash.stderr)
      assert.match(
        clash.stderr,
        new RegExp(
          `${folder.replaceAll('.', '\\.')}/${runId}\\.json is already here with other content`,
        ),
      )
      assert.equal(readFileSync(copy, 'utf8'), changed)
      const { rmSync } = await import('node:fs')
      rmSync(join(dir, '.reeval'), { recursive: true })
      rmSync(join(dir, folder), { recursive: true })
      const other = await runCli(dir, ['attach', '--download', '--profile', 'elsewhere', events], {
        env: env(p),
      })
      assert.equal(other.code, 3, other.stdout + other.stderr)
      assert.match(
        other.stderr,
        /hold \d+ entries outside \.reeval\/runs, \.reeval\/debug and other-history, or a link outside a snapshot/,
      )
      assert.ok(!existsSync(join(dir, '.reeval/runs')), 'nothing written')
      const fromEnv = await runCli(dir, ['attach', '--download', events], {
        env: { ...env(p), REEVAL_PROFILE: 'elsewhere' },
      })
      assert.equal(fromEnv.code, 3, fromEnv.stdout + fromEnv.stderr)
      assert.match(fromEnv.stderr, /\.reeval\/debug and other-history, or a link/)
      const unknown = await runCli(dir, ['attach', '--download', '--profile', 'nope', events], {
        env: env(p),
      })
      assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr)
      assert.match(unknown.stderr, /Unknown profile "nope"/)
      const alone = await runCli(dir, ['attach', '--profile', 'elsewhere', events], { env: env(p) })
      assert.equal(alone.code, 2, alone.stdout + alone.stderr)
      assert.match(alone.stderr, /--profile picks the history folder --download puts/)
    } finally {
      await p.close()
    }
  })

  test("a run recorded under a profile lands in that profile's history folder", async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'defineConfig({',
          `defineConfig({
  record: 'always',
  profiles: {
    elsewhere: { history: { store: { kind: 'local', dir: './other-history' } } },
    away: { history: { store: { kind: 'local', dir: '../shared-history' } } },
  },`,
        ),
      )
      const r = await runCli(dir, ['run', '--cloud', '--download', '--profile', 'elsewhere'], {
        env: env(p),
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const { runId } = recordOf(dir)
      assert.match(r.stdout, new RegExp(`recorded in other-history/${runId}\\.json`))
      assert.ok(existsSync(join(dir, 'other-history', runId, 'summary.md')))
      const { rmSync } = await import('node:fs')
      rmSync(join(dir, '.reeval'), { recursive: true })
      rmSync(join(dir, 'other-history'), { recursive: true })
      const events = `${p.base}/api/runs/run_1/events`
      const attach = await runCli(dir, ['attach', '--download', '--profile', 'elsewhere', events], {
        env: env(p),
      })
      assert.equal(attach.code, 0, attach.stdout + attach.stderr)
      assert.match(attach.stdout, new RegExp(`recorded in other-history/${runId}\\.json`))
      rmSync(join(dir, '.reeval'), { recursive: true })
      const away = await runCli(dir, ['attach', '--download', '--profile', 'away', events], {
        env: env(p),
      })
      assert.equal(away.code, 3, away.stdout + away.stderr)
      assert.match(
        away.stderr,
        /outside \.reeval\/runs and \.reeval\/debug \(this project's history folder, \S+shared-history, is outside it\)/,
      )
      assert.ok(!existsSync(join(dir, '.reeval/runs')), 'nothing written')
    } finally {
      await p.close()
    }
  })

  test('a history folder at the project root takes only runs', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'defineConfig({',
          `defineConfig({\n  record: 'always',\n  history: { store: { kind: 'local', dir: '.' } },`,
        ),
      )
      const r = await runCli(dir, ['run', '--cloud', '--download'], { env: env(p) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const { runId } = recordOf(dir)
      assert.match(r.stdout, new RegExp(`recorded in ${runId}\\.json`))
      assert.ok(existsSync(join(dir, runId, 'summary.md')))
      const events = `${p.base}/api/runs/run_1/events`
      for (const path of ['.git/config', 'notes.txt', '.reeval/store/x/history/a.json']) {
        p.serve((machine) => [
          ...machine,
          { type: 'file', path, mode: 0o644, mtime: 0, data: Buffer.from('x') },
        ])
        const got = await runCli(dir, ['attach', '--download', events], { env: env(p) })
        assert.equal(got.code, 3, `${path}: ${got.stdout}${got.stderr}`)
        assert.match(got.stderr, /outside \.reeval\/runs, \.reeval\/debug and \., or a link/)
        assert.ok(!existsSync(join(dir, path)), path)
      }
    } finally {
      await p.close()
    }
  })

  test('a history folder inside .reeval/runs takes its run from there, each path once', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'defineConfig({',
          `defineConfig({\n  record: 'always',\n  history: { store: { kind: 'local', dir: './.reeval/runs/recorded' } },`,
        ),
      )
      let served: TarEntry[] = []
      p.serve((machine) => {
        served = machine
        return machine
      })
      const r = await runCli(dir, ['run', '--cloud', '--download'], { env: env(p) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const paths = served.filter((e) => e.type !== 'dir').map((e) => e.path)
      assert.equal(new Set(paths).size, paths.length, 'each path once')
      const record = paths.find((e) => /^\.reeval\/runs\/recorded\/[^/]+\.json$/.test(e))
      assert.ok(record, paths.join(', '))
      assert.match(r.stdout, /recorded in \.reeval\/runs\/recorded\//)
      // The history folder's own .gitignore and .gitattributes belong to no run.
      assert.match(r.stdout, /Left out 2 files of cloud run run_1 that belong to no run/)
      for (const e of served) {
        if (e.type !== 'file' || /^\.reeval\/runs\/recorded\/\.git/.test(e.path)) continue
        assert.ok(readFileSync(join(dir, e.path)).equals(e.data), e.path)
      }
    } finally {
      await p.close()
    }
  })

  test("a run recorded into an s3() store's local copy lands in this project's copy", async () => {
    const s3 = await fakeS3()
    const keys = { AWS_ACCESS_KEY_ID: s3.accessKey, AWS_SECRET_ACCESS_KEY: s3.secretKey }
    const p = await platform({ env: keys })
    try {
      const dir = await fixtureProject()
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'defineConfig({',
          `defineConfig({\n  record: 'always',\n  history: { store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}', region: 'us-east-1' } },`,
        ),
      )
      const r = await runCli(dir, ['run', '--cloud', '--download'], { env: { ...env(p), ...keys } })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const { runId } = recordOf(dir)
      const copy = /recorded in (\.reeval\/store\/[^/]+\/history)\//.exec(r.stdout)?.[1]
      assert.ok(copy, r.stdout)
      assert.ok(existsSync(join(dir, copy, `${runId}.json`)))
      assert.ok(existsSync(join(dir, copy, runId, 'summary.md')))
      assert.ok(!existsSync(join(dir, '.reeval/store', copy.split('/')[2] ?? '', 'pending')))
    } finally {
      await p.close()
      await s3.close()
    }
  })

  test('refuse an archive with entries outside the runs, debug data and history, writing nothing', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud'], { env: env(p) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const evil = (path: string): TarEntry => ({
        type: 'file',
        path,
        mode: 0o644,
        mtime: 0,
        data: Buffer.from('x'),
      })
      const events = `${p.base}/api/runs/run_1/events`
      for (const [extra, shown] of [
        [evil('../outside.txt'), '../outside.txt'],
        [evil('.reeval/runs/../../escape.txt'), '.reeval/runs/../../escape.txt'],
        [evil('.reeval/config.json'), '.reeval/config.json'],
        [
          evil('.reeval/store/0123abcd/history/20261109T000000Z_x_y_abcd.json'),
          '.reeval/store/0123abcd/history/20261109T000000Z_x_y_abcd.json',
        ],
        [evil('runs/20261109T000000Z_x_y_abcd.json'), 'runs/20261109T000000Z_x_y_abcd.json'],
        [{ type: 'dir', path: '.git', mode: 0o755, mtime: 0 }, '.git'],
        [
          {
            type: 'symlink',
            path: '.reeval/debug/20261109T000000Z_x_y_abcd/link',
            mode: 0o777,
            mtime: 0,
            target: '/etc',
          },
          '.reeval/debug/20261109T000000Z_x_y_abcd/link',
        ],
      ] as const) {
        p.serve((machine) => [...machine, extra])
        const got = await runCli(dir, ['attach', '--download', events], { env: env(p) })
        assert.equal(got.code, 3, `${shown}: ${got.stdout}${got.stderr}`)
        assert.match(
          got.stderr,
          /the files of cloud run run_1 hold 1 entry outside \.reeval\/runs, \.reeval\/debug and evals\/\.history, or a link outside a snapshot/,
        )
        assert.ok(got.stderr.includes(shown), got.stderr)
        assert.ok(!existsSync(join(dir, '.reeval/runs')), `${shown}: nothing written`)
      }
      assert.ok(!existsSync(join(dir, '..', 'outside.txt')))
      // A stray file beside the runs, and one in the history folder: those are left out.
      p.serve((machine) => [
        { type: 'dir', path: '.', mode: 0o755, mtime: 0 },
        ...machine,
        evil('.reeval/runs/.tmp-1234'),
        evil('evals/.history/.gitignore'),
      ])
      const got = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(got.code, 0, got.stdout + got.stderr)
      assert.match(got.stdout, /Left out 2 files of cloud run run_1 that belong to no run/)
      assert.match(got.stdout, /Downloaded run \S+ of cloud run run_1/)
      assert.ok(!existsSync(join(dir, '.reeval/runs/.tmp-1234')))
      assert.ok(!existsSync(join(dir, 'evals/.history')))
    } finally {
      await p.close()
    }
  })

  test("keep a snapshot's links, and refuse paths that overlap or a directory that is a link", async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud'], { env: env(p) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const events = `${p.base}/api/runs/run_1/events`
      const attempt = (machine: TarEntry[]) => {
        const at = machine
          .map((e) => /^(\.reeval\/runs\/[^/]+\/[^/]+\/[^/]+\/\d+)\//.exec(e.path)?.[1])
          .find(Boolean)
        assert.ok(at, 'an attempt directory')
        return at
      }
      const file = (path: string, data = 'x'): TarEntry => ({
        type: 'file',
        path,
        mode: 0o644,
        mtime: 0,
        data: Buffer.from(data),
      })
      p.serve((machine) => [
        ...machine,
        file(`${attempt(machine)}/twice.txt`, 'a'),
        file(`${attempt(machine)}/twice.txt`, 'b'),
      ])
      const twice = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(twice.code, 3, twice.stdout + twice.stderr)
      assert.match(
        twice.stderr,
        /hold a path twice, or a file where another's directory is \(.*twice\.txt\)/,
      )
      p.serve((machine) => [
        ...machine,
        {
          type: 'symlink',
          path: `${attempt(machine)}/snapshots/after/x`,
          mode: 0o777,
          mtime: 0,
          target: '/tmp',
        },
        file(`${attempt(machine)}/snapshots/after/x/through.txt`),
      ])
      const through = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(through.code, 3, through.stdout + through.stderr)
      assert.match(through.stderr, /hold a path twice, or a file where another's directory is/)
      assert.ok(!existsSync(join(dir, '.reeval/runs')), 'nothing written')
      let link = ''
      p.serve((machine) => {
        link = `${attempt(machine)}/snapshots/after/AGENTS.md`
        return [
          ...machine,
          { type: 'symlink', path: link, mode: 0o777, mtime: 0, target: 'CLAUDE.md' },
        ]
      })
      const linked = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(linked.code, 0, linked.stdout + linked.stderr)
      assert.equal(readlinkSync(join(dir, link)), 'CLAUDE.md')
      const outside = tempDir('cloud-outside')
      p.serve((machine) => [
        ...machine,
        {
          type: 'symlink',
          path: `${attempt(machine)}/snapshots/after/Dir`,
          mode: 0o777,
          mtime: 0,
          target: outside,
        },
        file(`${attempt(machine)}/snapshots/after/dir/f.txt`),
      ])
      const folded = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.ok(!existsSync(join(outside, 'f.txt')), 'nothing written through the link')
      if (process.platform === 'darwin' || process.platform === 'win32') {
        assert.equal(folded.code, 3, folded.stdout + folded.stderr)
      } else {
        assert.equal(folded.code, 0, folded.stdout + folded.stderr)
      }
      p.serve((machine) => machine)
      const elsewhere = tempDir('cloud-elsewhere')
      const { renameSync } = await import('node:fs')
      renameSync(join(dir, '.reeval/runs'), join(elsewhere, 'runs'))
      symlinkSync(join(elsewhere, 'runs'), join(dir, '.reeval/runs'), 'dir')
      const { rmSync } = await import('node:fs')
      rmSync(join(dir, '.reeval/debug'), { recursive: true })
      const behind = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(behind.code, 2, behind.stdout + behind.stderr)
      assert.match(
        behind.stderr,
        /Not downloading the files of cloud run run_1: \.reeval\/runs is a link or a file here, not a directory, and nothing is written through one/,
      )
      assert.ok(!existsSync(join(dir, '.reeval/debug')), 'nothing written')
    } finally {
      await p.close()
    }
  })

  test('exit 2 for a stream that is not a cloud run, and for a run on this machine', async () => {
    const dir = await fixtureProject()
    const p = await platform()
    try {
      const file = join(tempDir('cloud-events'), 'run.ndjson')
      writeFileSync(file, '')
      for (const source of [file, 'http://elsewhere.test/api/runs/run_1/events']) {
        const r = await runCli(dir, ['attach', '--download', source], { env: env(p) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          /--download takes a cloud run's event stream URL \(http:\/\/127\.0\.0\.1:\d+\/api\/runs\/<run>\/events\)/,
        )
      }
      const unset = await runCli(dir, ['attach', '--download', `${p.base}/api/runs/run_1/events`], {
        env: { REEVAL_CLOUD_URL: '' },
      })
      assert.equal(unset.code, 2)
      assert.match(
        unset.stderr,
        /--download takes a cloud run's event stream URL \(https:\/\/cloud\.reeval\.ai\/api\/runs\/<run>\/events\)/,
      )
      const local = await runCli(dir, ['run', '--download'])
      assert.equal(local.code, 2, local.stdout + local.stderr)
      assert.match(
        local.stderr,
        /--download downloads a cloud run's files, and this run is on this machine/,
      )
      assert.deepEqual(p.seen, [], 'none of them called the platform')
    } finally {
      await p.close()
    }
  })

  test('--download reads REEVAL_CLOUD_URL from .env when the shell has none', async () => {
    const dir = await fixtureProject()
    const p = await platform()
    try {
      writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${TOKEN}\nREEVAL_CLOUD_URL=${p.base}\n`)
      await fetch(`${p.base}/ingest`, {
        method: 'POST',
        body: `${JSON.stringify({
          type: 'header',
          schemaVersion: 1,
          reeval: '0.0.0',
          runId: 'run_1',
          startedAt: '2026-01-01T00:00:00.000Z',
          pid: 1,
          host: 'platform',
          harness: 'fake',
          verbosity: 0,
        })}\n${JSON.stringify({ type: 'exit', at: 1, code: 0 })}\n`,
      })
      const fromFile = await runCli(
        dir,
        ['attach', '--download', `${p.base}/api/runs/run_1/events`],
        { env: { REEVAL_TOKEN: 'files-token' } },
      )
      assert.equal(fromFile.code, 0, fromFile.stdout + fromFile.stderr)
      assert.doesNotMatch(fromFile.stdout + fromFile.stderr, /cloud\.reeval\.ai/)
      assert.match(fromFile.stdout, /no files of run run_1/)
      const files = p.seen.find((s) => s.path === '/api/runs/run_1/artifacts/files.tar.gz')
      assert.equal(files?.auth, 'Bearer files-token')
      const socket = p.seen.find((s) => s.method === 'WS')
      assert.equal(socket?.auth, 'Bearer files-token', 'a cloud follow uses the URL from .env')
    } finally {
      await p.close()
    }
  })
})

describe('reeval run --cloud --resume', () => {
  const cloudConfig = (dir: string, profiles = '') => {
    const config = join(dir, 'reeval.config.ts')
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace(
        'defineConfig({',
        `defineConfig({\n  cloud: true,${profiles}`,
      ),
    )
  }
  const calls = (p: { seen: Seen[] }) =>
    p.seen.filter((s) => s.path !== '/ingest').map((s) => `${s.method} ${s.path}`)

  test('resumes the run and follows it to its new exit code, from its id or its events URL, with no project needed', async () => {
    const p = await platform({ resume: [], resumedCode: 1 })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud', '--resume', 'run_1'], { env })
      assert.equal(r.code, 1, r.stdout + r.stderr)
      assert.ok(
        r.stdout.indexOf('Resuming cloud run') < r.stdout.indexOf('Resumed cloud run'),
        r.stdout,
      )
      assert.match(
        r.stdout,
        /Resuming cloud run run_1 with the project as it was uploaded, without changes made here since; reeval run --cloud starts a new run/,
      )
      assert.match(
        r.stdout,
        /Resumed cloud run run_1; reeval attach .*\/api\/runs\/run_1\/events follows it/,
      )
      assert.deepEqual(calls(p), [
        'GET /api/runs/run_1',
        'POST /api/runs/run_1/resume',
        'WS /api/runs/run_1/events',
        'GET /api/runs/run_1',
      ])
      for (const s of p.seen)
        assert.equal(s.auth, 'Bearer cloud-test-token', `${s.method} ${s.path}`)
      assert.deepEqual(p.resumeBodies, [{ fromSegment: 0 }])
      const elsewhere = await runCli(
        tempDir('no-project'),
        ['run', '--cloud', '--resume', `${p.base.replace(/^http/, 'ws')}/api/runs/run_1/events`],
        { env },
      )
      assert.equal(elsewhere.code, 1, elsewhere.stdout + elsewhere.stderr)
      assert.match(elsewhere.stdout, /Resumed cloud run run_1; reeval attach/)
      assert.doesNotMatch(elsewhere.stdout, /as it was uploaded/)
      assert.deepEqual(p.resumeBodies.at(-1), { fromSegment: 1 })
    } finally {
      await p.close()
    }
  })

  test('a 200 follows the resume the platform already started', async () => {
    const p = await platform({ resume: [{ status: 200 }] })
    try {
      const r = await runCli(await fixtureProject(), ['run', '--cloud', '--resume', 'run_1'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Already resuming cloud run run_1; reeval attach/)
    } finally {
      await p.close()
    }
  })

  test('waits for a run that is still stopping, saying so once, then follows it', async () => {
    const stopping = { status: 409, code: 'still_stopping', message: 'stopping', retryAfter: '1' }
    const p = await platform({ resume: [stopping, stopping] })
    try {
      const r = await runCli(await fixtureProject(), ['run', '--cloud', '--resume', 'run_1'], {
        env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.equal(
        r.stdout.match(/Cloud run run_1 is still stopping: waiting up to 2 minutes to resume it/g)
          ?.length,
        1,
        r.stdout,
      )
      assert.match(r.stdout, /Resumed cloud run run_1/)
      assert.deepEqual(p.resumeBodies, [{ fromSegment: 0 }, { fromSegment: 0 }, { fromSegment: 0 }])
    } finally {
      await p.close()
    }
  })

  test('gives up with exit 3 once the run is still stopping after the wait, as Retry-After paces it', async () => {
    const { askToResume } = await import('../src/cloud-run.ts')
    let clock = 0
    const waits: number[] = []
    const lines: string[] = []
    let posts = 0
    const post = async () => {
      posts++
      return {
        status: 409,
        ok: false,
        body: { error: { code: 'still_stopping', message: 'stopping' } },
        headers: new Headers({ 'retry-after': '50' }),
      }
    }
    await assert.rejects(
      askToResume(post, 'run_1', (l) => lines.push(l), {
        now: () => clock,
        sleep: async (ms) => {
          waits.push(ms)
          clock += ms
        },
      }),
      (error: Error) =>
        error.name === 'CloudError' &&
        /cloud run run_1 is still stopping after 2 minutes: reeval run --cloud --resume run_1 tries again/.test(
          error.message,
        ),
    )
    assert.deepEqual(waits, [50_000, 50_000, 20_000])
    assert.equal(posts, 4)
    assert.equal(lines.length, 1)
  })

  test('a run the platform cannot resume, a complete one and a refused one exit 2 with why', async () => {
    const cases = [
      {
        options: {
          resume: [
            {
              status: 409,
              code: 'not_resumable',
              message: 'made with reeval 0.1.0; resuming needs 0.26.0 or later',
            },
          ],
        },
        said: /the cloud platform can't resume run run_1: made with reeval 0\.1\.0; resuming needs 0\.26\.0 or later/,
      },
      {
        options: {
          status: 'succeeded',
          resume: [{ status: 409, code: 'not_resumable', message: 'the run is complete' }],
        },
        said: /run run_1 is complete and cannot be resumed; reeval run --cloud starts a new run/,
      },
      {
        options: {
          resume: [{ status: 402, code: 'payment_required', message: 'Add a payment method.' }],
        },
        said: /the cloud platform refused to resume run run_1: Add a payment method\./,
      },
      {
        options: { resume: [{ status: 403, code: 'suspended', message: 'The org is suspended.' }] },
        said: /the cloud platform refused to resume run run_1: The org is suspended\./,
      },
    ]
    for (const { options, said } of cases) {
      const p = await platform(options)
      try {
        const r = await runCli(await fixtureProject(), ['run', '--cloud', '--resume', 'run_1'], {
          env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
        })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, said)
        assert.doesNotMatch(r.stdout, /Resuming cloud run/)
        assert.ok(!calls(p).includes('WS /api/runs/run_1/events'), 'nothing to follow')
      } finally {
        await p.close()
      }
    }
  })

  test('an unreachable platform exits 3', async () => {
    const p = await platform({ resume: [] })
    const base = p.base
    await p.close()
    const r = await runCli(await fixtureProject(), ['run', '--cloud', '--resume', 'run_1'], {
      env: { REEVAL_CLOUD_URL: base, REEVAL_TOKEN: 'cloud-test-token' },
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /couldn't read run run_1: .* didn't answer/)
  })

  test('refuses what the run started with, starting flags, no run and --local, with exit 2 before calling the platform', async () => {
    const p = await platform({ resume: [] })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const dir = await fixtureProject()
      const refused: Array<[string[], RegExp]> = [
        [['answer'], /leave out filters$/m],
        [
          ['--runs', '2'],
          /resumes with the filters, runs, tags and traits it started with: leave out --runs/,
        ],
        [['--tag', 't'], /leave out --tag/],
        [['--trait', 'k=v'], /leave out --trait/],
        [['--concurrency', '2'], /--concurrency applies to a run on this machine/],
        [['--dry-run'], /--dry-run applies to starting a cloud run, not resuming one/],
        [['--local'], /--cloud and --local pick where the run goes/],
      ]
      for (const [args, said] of refused) {
        const r = await runCli(dir, ['run', '--cloud', '--resume', 'run_1', ...args], { env })
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, said, args.join(' '))
      }
      const retry = await runCli(dir, ['run', '--cloud', '--retry-errors', 'run_1'], { env })
      assert.equal(retry.code, 2, retry.stdout + retry.stderr)
      assert.match(
        retry.stderr,
        /--retry-errors runs the infra errors of a run on this machine again, not of a cloud run/,
      )
      for (const ref of [[], ['latest'], ['latest~1']]) {
        const bare = await runCli(dir, ['run', '--cloud', '--resume', ...ref], { env })
        assert.equal(bare.code, 2, bare.stdout + bare.stderr)
        assert.match(bare.stderr, /pass the cloud run's id/, ref.join(' '))
      }
      const unknown = await runCli(dir, ['run', '--cloud', '--resume', 'run_1', '--profile', 'p'], {
        env,
      })
      assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr)
      assert.match(unknown.stderr, /Unknown profile "p"/)
      const raw = await runCli(dir, ['run', '--cloud', '--resume', 'run_1\u001b[2J'], { env })
      assert.equal(raw.code, 2, raw.stdout + raw.stderr)
      assert.match(raw.stderr, /isn't a cloud run's id: it holds control characters/)
      assert.ok(!raw.stderr.includes('\u001b'), 'the id is printed escaped')
      const profileHere = await runCli(
        tempDir('no-project'),
        ['run', '--cloud', '--resume', 'run_1', '--profile', 'p'],
        { env },
      )
      assert.equal(profileHere.code, 2, profileHere.stdout + profileHere.stderr)
      assert.match(profileHere.stderr, /--profile reads the project's config/)
      const both = await runCli(dir, ['run', '--local', '--cloud', '--resume'], { env })
      assert.equal(both.code, 2)
      assert.match(both.stderr, /--cloud and --local pick where the run goes/)
      const download = await runCli(
        tempDir('no-project'),
        ['run', '--cloud', '--resume', 'run_1', '--download'],
        { env },
      )
      assert.equal(download.code, 2, download.stdout + download.stderr)
      assert.match(download.stderr, /--download reads the project's config/)
      assert.deepEqual(p.seen, [], 'nothing reaches the platform')
    } finally {
      await p.close()
    }
  })

  test("with the config's cloud: true, a run this machine lacks resumes in the cloud, and --local looks only here", async () => {
    const p = await platform({ resume: [] })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const dir = await fixtureProject()
      cloudConfig(dir)
      const r = await runCli(dir, ['run', '--resume', 'run_1'], { env })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Resumed cloud run run_1/)
      const here = await runCli(dir, ['run', '--local', '--resume', 'run_2'], { env })
      assert.equal(here.code, 2, here.stdout + here.stderr)
      assert.match(here.stderr, /No run matches "run_2"/)
      const bare = await runCli(dir, ['run', '--resume'], { env })
      assert.equal(bare.code, 2, bare.stdout + bare.stderr)
      assert.match(bare.stderr, /pass the cloud run's id/)
      const retry = await runCli(dir, ['run', '--retry-errors'], { env })
      assert.equal(retry.code, 2, retry.stdout + retry.stderr)
      assert.match(
        retry.stderr,
        /--retry-errors runs the infra errors of a run on this machine again/,
      )
      assert.equal(calls(p).filter((c) => c.endsWith('/resume')).length, 1)
    } finally {
      await p.close()
    }
  })

  test("a run of this machine's continues here, under its saved profile or with a note when that profile runs in the cloud", async () => {
    const p = await platform({ resume: [] })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    /** The run's scratch record, rewritten as a budget stop that never ran its attempt. */
    const budgetStop = (dir: string) => {
      const runs = join(dir, '.reeval', 'runs')
      const name = readdirSync(runs).find((f) => f.endsWith('.json'))
      assert.ok(name)
      const run = JSON.parse(readFileSync(join(runs, name), 'utf8'))
      run.status = 'budget'
      for (const e of run.evals) {
        e.attempts = e.attempts.map((a: object) => ({
          ...a,
          outcome: 'skipped',
          error: null,
          files: {},
          checks: [],
        }))
      }
      writeFileSync(join(runs, name), JSON.stringify(run))
      return run.runId as string
    }
    try {
      const dev = await fixtureProject()
      cloudConfig(dev, `\n  profiles: { dev: { cloud: false } },`)
      const first = await runCli(dev, ['run', '--profile', 'dev'], { env })
      assert.equal(first.code, 0, first.stdout + first.stderr)
      const devRun = budgetStop(dev)
      const resumed = await runCli(dev, ['run', '--resume'], { env })
      assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr)
      assert.match(resumed.stdout, /1 passed/)
      assert.doesNotMatch(resumed.stdout, /continues here|cloud/i)
      const local = await fixtureProject()
      cloudConfig(local)
      const ran = await runCli(local, ['run', '--local'], { env })
      assert.equal(ran.code, 0, ran.stdout + ran.stderr)
      const localRun = budgetStop(local)
      const again = await runCli(local, ['run', '--resume', localRun], { env })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.match(
        again.stdout,
        new RegExp(`run ${localRun} ran on this machine, so it continues here`),
      )
      assert.match(again.stdout, /1 passed/)
      assert.notEqual(devRun, localRun)
      assert.deepEqual(p.seen, [], 'nothing reaches the platform')
    } finally {
      await p.close()
    }
  })

  test("a resume that adds nothing to the stream exits as the run's status says, never with the old exit line", async () => {
    const cases = [
      {
        status: 'failed' as const,
        code: 3,
        said: /cloud run run_1 failed: The machine never started\./,
      },
      { status: 'stopped' as const, code: 4, said: /reeval run --cloud --resume run_1/ },
    ]
    for (const { status, code, said } of cases) {
      const p = await platform({
        resume: [],
        resumeEnds: { status, message: 'The machine never started.' },
      })
      try {
        const r = await runCli(await fixtureProject(), ['run', '--cloud', '--resume', 'run_1'], {
          env: { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' },
        })
        assert.equal(r.code, code, `${status}: ${r.stdout}${r.stderr}`)
        assert.match(r.stdout + r.stderr, said, status)
        assert.ok(calls(p).includes('WS /api/runs/run_1/events'), 'it followed the stream')
      } finally {
        await p.close()
      }
    }
  })

  test('--profile picks a profile that runs in the cloud, and a run in neither place says so', async () => {
    const p = await platform({ resume: [] })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const dir = await fixtureProject()
      const config = join(dir, 'reeval.config.ts')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'defineConfig({',
          'defineConfig({\n  profiles: { cloudy: { cloud: true } },',
        ),
      )
      const r = await runCli(dir, ['run', '--profile', 'cloudy', '--resume', 'run_1'], { env })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Resumed cloud run run_1/)
      const nowhere = await runCli(dir, ['run', '--profile', 'cloudy', '--resume', 'run_9'], {
        env,
      })
      assert.equal(nowhere.code, 2, nowhere.stdout + nowhere.stderr)
      assert.match(nowhere.stderr, /No run matches "run_9" here or in the cloud/)
      const here = await runCli(dir, ['run', '--resume', 'run_1'], { env })
      assert.equal(here.code, 2, here.stdout + here.stderr)
      assert.match(here.stderr, /No run matches "run_1"/)
      assert.doesNotMatch(here.stderr, /in the cloud/)
      assert.equal(calls(p).filter((c) => c.endsWith('/resume')).length, 1)
    } finally {
      await p.close()
    }
  })

  test("a run downloaded from a cloud run resumes there by the cloud run's id, and --local continues it here", async () => {
    const ran = await platform()
    const dir = await fixtureProject()
    let runId: string
    try {
      const r = await runCli(dir, ['run', '--cloud', '--download'], {
        env: { REEVAL_CLOUD_URL: ran.base, REEVAL_TOKEN: 'cloud-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const name = readdirSync(join(dir, '.reeval/runs')).find((n) => n.endsWith('.json'))
      assert.ok(name)
      runId = name.slice(0, -'.json'.length)
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, '.reeval/cloud', `${runId}.json`), 'utf8')),
        { schemaVersion: 1, cloudRunId: 'run_1' },
      )
      const file = join(dir, '.reeval/runs', name)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      record.status = 'budget'
      for (const e of record.evals) {
        e.attempts = e.attempts.map((a: object) => ({
          ...a,
          outcome: 'skipped',
          error: null,
          files: {},
          checks: [],
        }))
      }
      writeFileSync(file, JSON.stringify(record))
    } finally {
      await ran.close()
    }
    const p = await platform({ resume: [] })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    try {
      const explicit = await runCli(dir, ['run', '--cloud', '--resume', runId.slice(0, 18)], {
        env,
      })
      assert.equal(explicit.code, 0, explicit.stdout + explicit.stderr)
      assert.match(explicit.stdout, new RegExp(`run ${runId} is cloud run run_1's download`))
      assert.match(explicit.stdout, /Resumed cloud run run_1/)
      cloudConfig(dir)
      for (const args of [['--resume'], ['--resume', runId]]) {
        const r = await runCli(dir, ['run', ...args], { env })
        assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stdout, /Already resuming cloud run run_1|Resumed cloud run run_1/)
        assert.doesNotMatch(r.stdout, /continues here/)
      }
      const resumes = calls(p).filter((c) => c.endsWith('/resume')).length
      assert.equal(resumes, 3)
      const local = await runCli(dir, ['run', '--local', '--resume', runId], { env })
      assert.equal(local.code, 0, local.stdout + local.stderr)
      assert.match(local.stdout, /1 passed/)
      assert.equal(calls(p).filter((c) => c.endsWith('/resume')).length, resumes)
    } finally {
      await p.close()
    }
  })
})
