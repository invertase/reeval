// `reeval run` on the hosted platform: a fake platform takes the bundle, runs it with
// `reeval run --bundle` as the platform's machine would, and serves its event stream, which the
// hosted run follows to the run's exit code.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { pkgRoot, project, runCli, tempDir } from './helpers.ts'

const TOKEN = 'hosted-check-token-value'

async function fixtureProject(answer = '42') {
  const p = await project('hosted', {})
  cpSync(join(pkgRoot, 'test/fixtures/bundle'), p.dir, { recursive: true })
  writeFileSync(join(p.dir, '.env'), `CHECK_TOKEN=${TOKEN}\n`)
  writeFileSync(join(p.dir, 'data/answer.txt'), `${answer}\n`)
  return p.dir
}

/** Where the platform's machine extracts a bundle, with `reeval` resolving to this package. */
function extractRoot(): string {
  const dir = tempDir('hosted-tmp')
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
 * The platform's API as the hosted run uses it: create, upload, start, the run's status and its
 * event socket. Starting runs the bundle with `reeval run --bundle --events-url`, posting to this
 * server, which numbers the lines and relays them as `{"seq":n,"line":…}` frames. With `fails`,
 * starting runs nothing: the socket closes with no exit line and the run reads as failed, with
 * `exitCode` when given.
 */
async function platform(options: { fails?: string; exitCode?: number } = {}) {
  const seen: Seen[] = []
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
        const file = join(tempDir('hosted-bundle'), 'bundle.tar.gz')
        writeFileSync(file, uploaded)
        vm = runCli(
          tempDir('hosted-vm'),
          ['run', '--bundle', file, '--events-url', `${base}/ingest`],
          { env: { TMPDIR: extractRoot(), CHECK_TOKEN: TOKEN } },
        )
      }
      return json(res, 202, run())
    }
    if (req.method === 'GET' && url.pathname === '/api/runs/run_1') return json(res, 200, run())
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
    close: async () => {
      await vm?.catch(() => {})
      for (const v of viewers) v.terminate()
      sockets.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

describe('reeval run on the hosted platform', () => {
  test('bundles, creates, uploads, starts and follows the run, with its exit code', async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject()
      const r = await runCli(dir, ['run', '--hosted'], {
        env: { REEVAL_HOSTED_URL: p.base, REEVAL_TOKEN: 'hosted-test-token' },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Running on hosted \(1 attempt\), --local to run here/)
      assert.match(r.stdout, /Started hosted run run_1/)
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
        assert.equal(s.auth, 'Bearer hosted-test-token', `${s.method} ${s.path}`)
      }
      const archive = p.uploaded
      assert.ok(archive)
      assert.deepEqual(p.declared, {
        bundleSha256: createHash('sha256').update(archive).digest('hex'),
        bundleBytes: archive.length,
      })
      assert.ok(!archive.includes(TOKEN), 'no secret value in the bundle')
      const again = await runCli(dir, ['attach', `${p.base}/api/runs/run_1/events`], {
        env: { REEVAL_HOSTED_URL: p.base, REEVAL_TOKEN: 'hosted-test-token' },
      })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.equal(p.seen.at(-1)?.auth, 'Bearer hosted-test-token', 'reeval attach sends it too')
    } finally {
      await p.close()
    }
  })

  test("exits with the run's exit code when it fails, from the config's hosted: true", async () => {
    const p = await platform()
    try {
      const dir = await fixtureProject('41')
      const config = join(dir, 'reeval.config.ts')
      const { readFileSync } = await import('node:fs')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace('defineConfig({', 'defineConfig({\n  hosted: true,'),
      )
      const r = await runCli(dir, ['run'], { env: { REEVAL_HOSTED_URL: p.base } })
      assert.equal(r.code, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /Running on hosted/)
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
      const r = await runCli(await fixtureProject(), ['run', '--hosted'], {
        env: { REEVAL_HOSTED_URL: p.base },
      })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /hosted run run_1 failed: the run could not start/)
    } finally {
      await p.close()
    }
  })

  test("a run that ends on the platform before its exit line exits with the platform's code", async () => {
    const p = await platform({ fails: 'the plan differs from the bundle', exitCode: 2 })
    try {
      const r = await runCli(await fixtureProject(), ['run', '--hosted'], {
        env: { REEVAL_HOSTED_URL: p.base },
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stdout, /hosted run run_1 ended: the plan differs from the bundle/)
    } finally {
      await p.close()
    }
  })

  test('exit 2 without REEVAL_HOSTED_URL, and for flags a hosted run cannot take', async () => {
    const dir = await fixtureProject()
    const unset = await runCli(dir, ['run', '--hosted'], { env: { REEVAL_HOSTED_URL: '' } })
    assert.equal(unset.code, 2)
    assert.match(unset.stderr, /A hosted run needs REEVAL_HOSTED_URL.*pass --local to run here/)
    const both = await runCli(dir, ['run', '--hosted', '--local'])
    assert.equal(both.code, 2)
    assert.match(both.stderr, /--hosted and --local pick where the run goes/)
    const local = await runCli(dir, ['run', '--hosted', '--concurrency', '2'], {
      env: { REEVAL_HOSTED_URL: 'http://127.0.0.1:9' },
    })
    assert.equal(local.code, 2)
    assert.match(local.stderr, /--concurrency applies to a run on this machine/)
    const creds = await runCli(dir, ['run', '--hosted'], {
      env: { REEVAL_HOSTED_URL: 'https://u:secret@platform.test' },
    })
    assert.equal(creds.code, 2)
    assert.match(creds.stderr, /can't carry a user name or password/)
    assert.ok(!creds.stderr.includes('secret@'))
    const p = await platform()
    try {
      const token = await runCli(dir, ['run', '--hosted'], {
        env: { REEVAL_HOSTED_URL: p.base, REEVAL_TOKEN: 'abc\ndef' },
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
    const r = await runCli(await fixtureProject(), ['run', '--hosted'], {
      env: { REEVAL_HOSTED_URL: base },
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /couldn't read the hosted platform's config/)
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
      const r = await runCli(dir, ['run', '--hosted', '--dry-run'], {
        env: { REEVAL_HOSTED_URL: p.base },
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /target {2}here, not hosted: tart\(\) runs its VMs on a Mac/)
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
      const { readFileSync } = await import('node:fs')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          '({ skill, secret }) => ({',
          "({ skill, secret, file }) => ({\n    files: { 'notes.txt': file('./notes.txt') },",
        ),
      )
      const host = tempDir('hosted-host')
      writeFileSync(join(host, 'notes.txt'), 'notes\n')
      symlinkSync(join(host, 'notes.txt'), join(dir, 'notes.txt'))
      const r = await runCli(dir, ['run', '--hosted'], { env: { REEVAL_HOSTED_URL: p.base } })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Running here, not on hosted: .*outside the bundle root/)
      assert.match(r.stdout, /1 passed/)
      assert.deepEqual(p.seen, [], 'a run that stays here never calls the platform')
    } finally {
      await p.close()
    }
  })
})
