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
import { pkgRoot, project, runCli, tempDir } from './helpers.ts'

const TOKEN = 'cloud-check-token-value'

async function fixtureProject(answer = '42') {
  const p = await project('cloud', {})
  cpSync(join(pkgRoot, 'test/fixtures/bundle'), p.dir, { recursive: true })
  writeFileSync(join(p.dir, '.env'), `CHECK_TOKEN=${TOKEN}\n`)
  writeFileSync(join(p.dir, 'data/answer.txt'), `${answer}\n`)
  return p.dir
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
 * its `.reeval/runs` and `.reeval/debug`, and the paths the run-end event's `recorded` names.
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
  const recorded = Object.values(end?.recorded ?? {}).filter((p): p is string => !!p)
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
 * `exitCode` when given.
 */
async function platform(options: { fails?: string; exitCode?: number } = {}) {
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
  const run = () => ({
    id: 'run_1',
    status: options.fails ? 'failed' : over ? 'succeeded' : 'running',
    error: options.fails ? { code: 'start_failed', message: options.fails } : null,
    exitCode: options.exitCode ?? null,
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    seen.push({ method: req.method ?? '', path: url.pathname, auth: req.headers.authorization })
    const body = await bodyOf(req)
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { gatewayBaseUrl: null })
    }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
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
      } else {
        const file = join(tempDir('cloud-bundle'), 'bundle.tar.gz')
        writeFileSync(file, uploaded)
        vm = runCli(
          tempDir('cloud-vm'),
          ['run', '--bundle', file, '--events-url', `${base}/ingest`],
          { env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN } },
        )
      }
      return json(res, 202, run())
    }
    if (req.method === 'GET' && url.pathname === '/api/runs/run_1') return json(res, 200, run())
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
          'POST /api/runs',
          'PUT /api/runs/run_1/bundle',
          'POST /api/runs/run_1/start',
          'WS /api/runs/run_1/events',
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
            [`${p.base}/`]: {
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

  test('exit 2 without REEVAL_CLOUD_URL, and for flags a cloud run cannot take', async () => {
    const dir = await fixtureProject()
    const unset = await runCli(dir, ['run', '--cloud'], { env: { REEVAL_CLOUD_URL: '' } })
    assert.equal(unset.code, 2)
    assert.match(unset.stderr, /A cloud run needs REEVAL_CLOUD_URL.*pass --local to run here/)
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
      for (const e of served) {
        const here = join(dir, e.path)
        if (e.type === 'file') assert.ok(readFileSync(here).equals(e.data), e.path)
        if (e.type === 'symlink') assert.equal(readlinkSync(here), e.target, e.path)
      }
      assert.ok(existsSync(join(dir, folder, `${runId}.zip`)))
      assert.ok(existsSync(join(dir, folder, runId, 'summary.md')))
      const listed = await runCli(dir, ['history'])
      assert.equal(listed.code, 0, listed.stdout + listed.stderr)
      assert.match(listed.stdout, new RegExp(runId.slice(0, 15)))
      const events = `${p.base}/api/runs/run_1/events`
      const again = await runCli(dir, ['attach', '--download', events], { env: env(p) })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.match(again.stdout, new RegExp(`Run ${runId} of cloud run run_1 is already in`))
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
      assert.match(unset.stderr, /--download needs REEVAL_CLOUD_URL/)
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
})
