// The egress gateway over an exec transport, without Docker: the forwarder runs as a local `node`
// child, so its 127.0.0.1 is the host's, and a fake `run` stands in for the CA install.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
      await gateway.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Whether `pid` runs: a killed process its parent hasn't reaped yet is a zombie, not alive. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, 'utf8') : ''
  return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
}

/** The forwarders' pid files on the host, which the orphaning transport's sandbox is. */
const pidFiles = () =>
  readdirSync('/tmp').filter((f) => /^reeval-egress-forwarder-.+\.pid$/.test(f))

describe('a transport that orphans its processes', { timeout: 30_000 }, () => {
  // Killing the host's `sh` leaves the forwarder it started in the background running, as killing
  // `tart exec` or `ssh` can leave it in the VM; `run` runs the gateway's own commands for real.
  const orphaning: ExecTransport = {
    argv: (command) => ['sh', '-c', '"$@" <&0 & wait', 'sh', ...command],
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
    run: async (command, { input }) => {
      if (command.join(' ').includes('ca-certificates')) {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' }
      }
      const r = spawnSync(command[0] ?? '', command.slice(1), { input })
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString() }
    },
    orphans: true,
  }

  test('stops a forwarder an earlier gateway left, then its own once it closes', async () => {
    const stale = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    const staleFile = '/tmp/reeval-egress-forwarder-stale.pid'
    writeFileSync(staleFile, String(stale.pid))
    let gateway: Awaited<ReturnType<typeof startGateway>> | undefined
    let own = 0
    try {
      gateway = await startGateway(orphaning, { policy: { mode: 'allow-all' } })
      await eventually('the stale forwarder was stopped', () => !alive(stale.pid ?? 0))
      const [file, ...more] = pidFiles()
      assert.deepEqual(more, [], 'one forwarder runs')
      own = Number(readFileSync(join('/tmp', file ?? ''), 'utf8'))
      assert.ok(alive(own), 'its own forwarder runs')
    } finally {
      stale.kill('SIGKILL')
      rmSync(staleFile, { force: true })
      await gateway?.close()
    }
    await eventually('closing stopped its forwarder', () => !alive(own))
    assert.deepEqual(pidFiles(), [], 'and removed its pid file')
  })

  test('a transport that does not orphan has its forwarder left to it', async () => {
    const { transport, runs } = localTransport({ exitCode: 0 })
    const gateway = await startGateway(transport, { policy: { mode: 'allow-all' } })
    await gateway.close()
    assert.equal(runs.length, 1, 'only the CA install ran in the sandbox')
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
