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
 * reads as stopped, for that reason.
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
  const run = () => ({
    id: 'run_1',
    status: options.fails
      ? 'failed'
      : options.stops
        ? 'stopped'
        : canceled
          ? over
            ? 'cancelled'
            : 'running'
          : over
            ? 'succeeded'
            : 'running',
    error: options.fails
      ? { code: 'start_failed', message: options.fails }
      : options.stops
        ? { code: 'stopped_by_platform', message: options.stops }
        : null,
    exitCode: options.exitCode ?? null,
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
    if (req.method === 'GET' && url.pathname === '/api/runs/run_1') return json(res, 200, run())
    if (req.method === 'POST' && url.pathname === '/api/runs/run_1/cancel') {
      if (over) return json(res, 200, run())
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
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

  test('Ctrl-C without a terminal detaches and the run goes on, from reeval run and reeval attach', async () => {
    const p = await platform({ holds: true })
    const env = { REEVAL_CLOUD_URL: p.base, REEVAL_TOKEN: 'cloud-test-token' }
    const interrupt = (stdout: string, pid: number) => {
      if (!stdout.includes('held')) return false
      process.kill(pid, 'SIGINT')
      return true
    }
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--cloud'], { env, onOutput: interrupt })
      assert.equal(r.code, 130, r.stdout + r.stderr)
      assert.match(
        r.stdout,
        /Cloud run run_1 goes on: reeval attach \S+\/api\/runs\/run_1\/events follows it again; reeval cloud run cancel run_1 cancels it/,
      )
      const again = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], {
        env,
        onOutput: interrupt,
      })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.match(again.stdout, /Detached from run r-held\./)
      assert.ok(!p.seen.some((s) => s.path.endsWith('/cancel')), 'detaching cancels nothing')
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
