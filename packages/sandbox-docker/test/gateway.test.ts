// The egress gateway over an exec transport, without Docker: the forwarder runs as a local `node`
// child, so its 127.0.0.1 is the host's, and a fake `run` stands in for the CA install.
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { PROXY_PORT, startGateway } from '../src/egress/gateway.ts'
import {
  containerTransport,
  type ExecEnd,
  type ExecTransport,
  execRun,
} from '../src/egress/transport.ts'

type Traced = { argv: readonly string[]; end: ExecEnd }

/** Runs `node` commands on the host, and answers every other command with `answer`. */
function localTransport(
  answer: { exitCode: number; stdout?: string; stderr?: string } = { exitCode: 0 },
  forwarder: readonly string[] = [],
) {
  const runs: { command: readonly string[]; input: string }[] = []
  const traced: Traced[] = []
  const transport: ExecTransport = {
    argv: (command) =>
      command[0] === 'node' ? [process.execPath, ...forwarder, ...command.slice(1)] : [...command],
    env: { REEVAL_FAKE_TRANSPORT: '1' },
    run: async (command, { input }) => {
      runs.push({ command, input })
      return { stdout: Buffer.from(answer.stdout ?? ''), stderr: answer.stderr ?? '', ...answer }
    },
    trace: (argv, _startedAt, end) => traced.push({ argv, end }),
  }
  return { transport, runs, traced }
}

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  )

const get = (options: http.RequestOptions) =>
  new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = http.get(options, (res) => {
      let body = ''
      res.on('data', (d) => {
        body += d
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.once('error', reject)
  })

const eventually = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(check(), what)
}

describe('the gateway over an exec transport', { timeout: 30_000 }, () => {
  test('installs its CA, then proxies and tunnels through the forwarder the transport started', async () => {
    const { transport, runs, traced } = localTransport({ exitCode: 0 })
    const upstream = http.createServer((req, res) => res.end(`upstream saw ${req.url}`))
    const upstreamPort = await listen(upstream)
    const echo = net.createServer((s) => s.pipe(s))
    const echoPort = await listen(echo)
    const gateway = await startGateway(transport, {
      policy: { mode: 'allow-all' },
      allowLoopback: true,
    })
    try {
      assert.equal(runs.length, 1, 'one command installs the CA')
      assert.deepEqual(runs[0]?.command.slice(0, 2), ['sh', '-c'])
      assert.doesNotThrow(() => new X509Certificate(runs[0]?.input ?? ''), 'the CA goes on stdin')
      assert.equal(gateway.env.HTTPS_PROXY, `http://127.0.0.1:${PROXY_PORT}`)
      assert.equal(gateway.env.SSL_CERT_FILE, undefined, 'no system bundle without its marker')

      const proxied = await get({
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: `http://127.0.0.1:${upstreamPort}/hello`,
      })
      assert.deepEqual(proxied, { status: 200, body: 'upstream saw /hello' })

      const url = new URL(await gateway.portUrl(echoPort, 'http'))
      const socket = net.connect(Number(url.port), url.hostname)
      socket.end('ping')
      let echoed = ''
      for await (const chunk of socket) echoed += chunk
      assert.equal(echoed, 'ping', 'the port tunnel reaches the sandbox side')
      assert.equal(gateway.stopped, undefined)
    } finally {
      gateway.close()
      upstream.close()
      echo.close()
    }
    await eventually('the forwarder is traced as it ends', () => traced.length === 1)
    assert.equal(traced[0]?.argv[0], process.execPath)
    assert.deepEqual(traced[0]?.argv.slice(1, 2), ['-e'])
  })

  test('sets the system bundle variables when the install reports it rebuilt the bundle', async () => {
    const { transport } = localTransport({ exitCode: 0, stdout: 'reeval:ca-bundle\n' })
    const gateway = await startGateway(transport, { policy: { mode: 'allow-all' } })
    try {
      assert.equal(gateway.env.SSL_CERT_FILE, '/etc/ssl/certs/ca-certificates.crt')
    } finally {
      gateway.close()
    }
  })

  test('a failed CA install starts no forwarder', async () => {
    const { transport, traced } = localTransport({ exitCode: 1, stderr: 'read-only file system\n' })
    await assert.rejects(
      startGateway(transport, { policy: { mode: 'allow-all' } }),
      /couldn't install the gateway CA: read-only file system$/,
    )
    assert.equal(traced.length, 0)
  })

  test('a forwarder that exits before it is ready fails the start with its stderr', async () => {
    const { transport } = localTransport({ exitCode: 0 }, [
      '-e',
      'process.stderr.write("node: not found\\n"); process.exit(127)',
      '--',
    ])
    await assert.rejects(
      startGateway(transport, { policy: { mode: 'allow-all' } }),
      /the forwarder exited \(127\): node: not found/,
    )
  })

  test('stops on its own when the forwarder dies, and refuses ports after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reeval-gateway-'))
    const preload = join(dir, 'pid.cjs')
    const pidFile = join(dir, 'pid')
    writeFileSync(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    )
    const { transport } = localTransport({ exitCode: 0 }, ['-r', preload])
    const gateway = await startGateway(transport, { policy: { mode: 'allow-all' } })
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      await eventually('the gateway reports it stopped', () => gateway.stopped !== undefined)
      assert.match(gateway.stopped ?? '', /^the forwarder exited/)
      await assert.rejects(gateway.portUrl(1234, 'http'), /the egress gateway stopped/)
    } finally {
      gateway.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('execRun', () => {
  test('runs the argv the transport gives, with stdin, and traces it', async () => {
    const traced: Traced[] = []
    const r = await execRun(
      {
        argv: (command) => ['sh', '-c', 'printf "%s:" "$REEVAL_T"; cat', '--', ...command],
        env: { REEVAL_T: 'env' },
        trace: (argv, _startedAt, end) => traced.push({ argv, end }),
      },
      ['ignored'],
      { input: 'stdin' },
    )
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout.toString(), 'env:stdin')
    assert.equal(traced.length, 1)
    assert.deepEqual(traced[0]?.argv.at(-1), 'ignored')
    assert.equal('stdin' in (traced[0]?.end ?? {}) && traced[0]?.end.stdin, 5)
  })
})

describe('containerTransport', () => {
  test('execs into the container as root, interactively, on its engine', () => {
    const command = ['node', '-e', 'x']
    assert.deepEqual(containerTransport('abc').argv(command), [
      'docker',
      'exec',
      '--interactive',
      '--user',
      '0:0',
      'abc',
      'node',
      '-e',
      'x',
    ])
    assert.equal(containerTransport('abc', 'podman').argv(command)[0], 'podman')
  })
})
