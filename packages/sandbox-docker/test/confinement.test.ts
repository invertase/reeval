// What confines a sandbox container: the unprivileged user, no capabilities, no-new-privileges,
// and memory, CPU and process limits; and that, as that user, the agent can't get around or
// reconfigure the egress gateway. Each probe has a twin that must see the opposite, so it can fail.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import type net from 'node:net'
import { after, before, describe, test } from 'node:test'
import { buildInstallLayer } from '../src/build-image.ts'
import { dockerCapacity } from '../src/docker-cli.ts'
import { CA_BUNDLE, CA_PATH, PROXY_PORT } from '../src/egress/gateway.ts'
import { DEFAULT_IMAGE, SANDBOX_HOME, SANDBOX_USER } from '../src/image.ts'
import {
  createDockerSession,
  DEFAULT_LIMITS,
  type DockerSession,
  type SessionOptions,
} from '../src/session.ts'

const dockerReady =
  process.env.REEVAL_TEST_REQUIRE_DOCKER === '1' ||
  (() => {
    try {
      execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

/** reeval's image with iptables and iproute2, built once (as root, like every image build). */
const NET_TOOLS_IMAGE = `reeval-test-net-tools:${DEFAULT_IMAGE.split(':')[1]}`

/** Capability bits, from linux/capability.h. */
const CAP = { CHOWN: 0, DAC_OVERRIDE: 1, FOWNER: 3, SETGID: 6, SETUID: 7, NET_RAW: 13 } as const
const mask = (...bits: number[]) => bits.reduce((m, b) => m | (1n << BigInt(b)), 0n)

/** The shell's capability sets and no_new_privs flag, from /proc/self/status. */
async function privileges(s: DockerSession) {
  const status = (await s.run({ command: 'cat /proc/self/status' })).stdout
  const field = (name: string) => new RegExp(`^${name}:\\s+(\\S+)$`, 'm').exec(status)?.[1] ?? ''
  return {
    effective: BigInt(`0x${field('CapEff')}`),
    permitted: BigInt(`0x${field('CapPrm')}`),
    bounding: BigInt(`0x${field('CapBnd')}`),
    ambient: BigInt(`0x${field('CapAmb')}`),
    noNewPrivs: field('NoNewPrivs'),
  }
}

/**
 * Starts `count` sleeps at once from Node and reports how many the kernel let start, then kills
 * them (not the container's own `sleep`).
 */
const spawnMany = (count: number) =>
  `node -e 'const { spawn } = require("node:child_process"); let ok = 0, failed = 0; for (let i = 0; i < ${count}; i++) { const c = spawn("sleep", ["31"], { stdio: "ignore" }); c.on("error", () => failed++); if (c.pid) ok++ } setTimeout(() => { console.log(JSON.stringify({ ok, failed })); process.exit(0) }, 1000)'; pkill -xf "sleep 31"; true`

/** Allocates and touches `mb` MiB in Node; exits 0 if it all fit. */
const allocate = (mb: number) =>
  `node -e 'const b = []; for (let i = 0; i < ${mb}; i++) b.push(Buffer.alloc(1 << 20, 1)); console.log("allocated", b.length)'`

const cgroup = async (s: DockerSession, file: string) =>
  (await s.run({ command: `cat /sys/fs/cgroup/${file}` })).stdout.trim()

describe('sandbox confinement in Docker', {
  skip: !dockerReady && `needs Docker and ${DEFAULT_IMAGE}`,
}, () => {
  const sessions: DockerSession[] = []
  const open = async (options: Partial<SessionOptions> = {}) => {
    const s = await createDockerSession({ image: DEFAULT_IMAGE, ...options })
    sessions.push(s)
    return s
  }
  after(async () => {
    await Promise.all(sessions.map((s) => s.destroy()))
  })

  test('every command, spawn and file write runs as the unprivileged sandbox user', async () => {
    const s = await open()
    const id = await s.run({ command: 'echo "$(id -u) $(id -un) $HOME"' })
    assert.equal(id.stdout.trim(), `10001 ${SANDBOX_USER} ${SANDBOX_HOME}`)
    const spawned = await s.spawn({ command: 'id -u' })
    assert.equal((await new Response(spawned.stdout).text()).trim(), '10001')
    await s.writeTextFile({ path: 'owned.txt', content: 'x' })
    await s.writeTextFile({ path: `${SANDBOX_HOME}/.config/owned.txt`, content: 'x' })
    const owners = await s.run({
      command: `stat -c %U owned.txt ${SANDBOX_HOME}/.config/owned.txt`,
    })
    assert.equal(owners.stdout, `${SANDBOX_USER}\n${SANDBOX_USER}\n`)
    const root = await s.run({ command: 'ls /root; touch /etc/reeval-test; apt-get update' })
    assert.notEqual(root.exitCode, 0)
    assert.match(root.stderr, /Permission denied/)
    // Twin: root: true runs the same commands as root, so the probe can tell.
    const r = await open({ root: true })
    assert.equal((await r.run({ command: 'id -u' })).stdout.trim(), '0')
  })

  test('no capabilities, and no-new-privileges; root: true adds back only what apt-get needs', async () => {
    const s = await open()
    const p = await privileges(s)
    assert.deepEqual(
      [p.effective, p.permitted, p.bounding, p.ambient, p.noNewPrivs],
      [0n, 0n, 0n, 0n, '1'],
    )
    assert.equal((await s.run({ command: 'test -e /var/run/docker.sock' })).exitCode, 1)

    // Twins: an added capability shows up in the same probe, and root gets exactly its set.
    const raw = await privileges(await open({ capabilities: ['NET_RAW'] }))
    assert.equal(raw.bounding, mask(CAP.NET_RAW))
    const r = await open({ root: true })
    const rp = await privileges(r)
    const rootSet = mask(CAP.CHOWN, CAP.DAC_OVERRIDE, CAP.FOWNER, CAP.SETGID, CAP.SETUID)
    assert.equal(rp.effective, rootSet)
    assert.equal(rp.bounding, rootSet)
    assert.equal(rp.noNewPrivs, '1')
  })

  test('default limits: memory with as much swap on top, CPUs and processes', async () => {
    const s = await open()
    const cpus = Math.min(DEFAULT_LIMITS.cpus, (await dockerCapacity())?.cpus ?? Infinity)
    assert.deepEqual(
      {
        memory: await cgroup(s, 'memory.max'),
        swap: await cgroup(s, 'memory.swap.max'),
        cpu: await cgroup(s, 'cpu.max'),
        pids: await cgroup(s, 'pids.max'),
      },
      {
        memory: String(4 * 1024 ** 3),
        swap: String(4 * 1024 ** 3),
        cpu: `${cpus * 100_000} 100000`,
        pids: String(DEFAULT_LIMITS.pids),
      },
    )
  })

  test('each limit is overridable, and CPUs are capped at what the Docker host has', async () => {
    const s = await open({ limits: { memory: '256m', cpus: 0.5, pids: 200 } })
    assert.equal(await cgroup(s, 'memory.max'), String(256 * 1024 ** 2))
    assert.equal(await cgroup(s, 'cpu.max'), '50000 100000')
    assert.equal(await cgroup(s, 'pids.max'), '200')
    const host = (await dockerCapacity())?.cpus
    if (host) {
      const wide = await open({ limits: { cpus: host + 64 } })
      assert.equal(await cgroup(wide, 'cpu.max'), `${host * 100_000} 100000`)
    }
  })

  test('a fork bomb stops at the process limit, and the container still answers', async () => {
    const s = await open()
    const bomb = JSON.parse((await s.run({ command: spawnMany(1500) })).stdout)
    assert.ok(bomb.ok < DEFAULT_LIMITS.pids, `started ${bomb.ok} of 1500`)
    assert.ok(bomb.failed > 0)
    assert.equal((await s.run({ command: 'echo alive' })).stdout, 'alive\n')
    const small = await open({ limits: { pids: 64 } })
    const capped = JSON.parse((await small.run({ command: spawnMany(200) })).stdout)
    assert.ok(capped.ok < 64, `started ${capped.ok} of 200 under pids: 64`)
    // Twin: under a higher limit the same burst all starts.
    const wide = await open({ limits: { pids: 512 } })
    assert.deepEqual(JSON.parse((await wide.run({ command: spawnMany(200) })).stdout), {
      ok: 200,
      failed: 0,
    })
  })

  test('swap: 0 makes memory the hard ceiling; a set swap is on top', async () => {
    const hard = await open({ limits: { memory: '256m', swap: 0 } })
    assert.equal(await cgroup(hard, 'memory.swap.max'), '0')
    // Twin: a set swap lands in the same file.
    const some = await open({ limits: { memory: '256m', swap: '64m' } })
    assert.equal(await cgroup(some, 'memory.swap.max'), String(64 * 1024 ** 2))
  })

  test('memory past the limit is killed, and the container survives it', async () => {
    const s = await open({ limits: { memory: '128m', swap: 0 } })
    const big = await s.run({ command: allocate(512) })
    assert.equal(big.exitCode, 137, `a 512 MiB allocation under 128m: ${big.stdout}`)
    assert.equal((await s.run({ command: 'echo alive' })).stdout, 'alive\n')
    // Twin: an allocation that fits succeeds, so the allocator works.
    assert.equal((await s.run({ command: allocate(16) })).stdout, 'allocated 16\n')
  })

  test('install layers put ~ in the sandbox user’s home, owned by it', async () => {
    const parent = {
      ref: DEFAULT_IMAGE,
      id: execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', DEFAULT_IMAGE], {
        encoding: 'utf8',
      }).trim(),
    }
    const tag = await buildInstallLayer(parent, [
      {
        run: 'test "$(id -u)" = 0 && mkdir -p ~/.tool/bin && printf "#!/bin/sh\\necho tool ok\\n" > ~/.tool/bin/t && chmod +x ~/.tool/bin/t',
      },
    ])
    const s = await open({ image: tag })
    const r = await s.run({ command: '~/.tool/bin/t && touch ~/.tool/cache && stat -c %U ~/.tool' })
    assert.equal(r.stdout, `tool ok\n${SANDBOX_USER}\n`, r.stderr)
  })
})

describe('the egress gateway as the sandbox user', {
  skip: !dockerReady && `needs Docker and ${DEFAULT_IMAGE}`,
}, () => {
  const sessions: DockerSession[] = []
  let listener: { port: number; hits: number; close(): void }
  const open = async (options: Partial<SessionOptions> = {}) => {
    const s = await createDockerSession({
      image: NET_TOOLS_IMAGE,
      egress: {
        policy: { mode: 'custom', allowedHosts: ['upstream.test'] },
        lookup: async (host) => (host === 'upstream.test' ? ['127.0.0.1'] : ['1.1.1.1']),
        allowLoopback: true,
      },
      ...options,
    })
    sessions.push(s)
    return s
  }
  /** A plain request through the gateway to the host's listener. */
  const viaGateway = (s: DockerSession) =>
    s.run({
      command: `curl -sS --max-time 10 -o /dev/null -w '%{http_code}' http://upstream.test:${listener.port}/`,
    })

  before(() => {
    execFileSync('docker', ['build', '-q', '-t', NET_TOOLS_IMAGE, '-'], {
      input: `FROM ${DEFAULT_IMAGE}\nRUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 && rm -rf /var/lib/apt/lists/*\n`,
      stdio: ['pipe', 'ignore', 'inherit'],
    })
    const server = http.createServer((_, res) => {
      box.hits++
      res.end('ok')
    })
    const box = { port: 0, hits: 0, close: () => server.close() }
    server.listen(0, '0.0.0.0')
    return new Promise<void>((resolve) =>
      server.once('listening', () => {
        box.port = (server.address() as net.AddressInfo).port
        listener = box
        resolve()
      }),
    )
  })
  after(async () => {
    await Promise.all(sessions.map((s) => s.destroy()))
    listener?.close()
  })

  test('network configuration, iptables and new namespaces are refused', async () => {
    const s = await open()
    for (const command of [
      'ip link set lo down',
      'ip addr add 10.9.9.9/24 dev lo',
      'ip route add default dev lo',
      'iptables -P OUTPUT ACCEPT',
      'iptables -L',
      'unshare --user --map-root-user --net true',
    ]) {
      const r = await s.run({ command })
      assert.notEqual(r.exitCode, 0, `${command} succeeded as the sandbox user`)
      assert.match(r.stderr, /not permitted|Permission denied|must be run as root/i, command)
    }
    assert.equal((await viaGateway(s)).stdout, '200', 'the gateway still works afterwards')
    // Twin: with root and NET_ADMIN the same commands work, so the probe can tell.
    const admin = await open({ root: true, capabilities: ['NET_ADMIN'] })
    const r = await admin.run({
      command: 'ip addr add 10.9.9.9/24 dev lo && iptables -L >/dev/null',
    })
    assert.equal(r.exitCode, 0, r.stderr)
  })

  test('changing or dropping the proxy variables finds no other way out', async () => {
    const s = await open()
    const hits = listener.hits
    for (const command of [
      `curl -sS --noproxy '*' --max-time 3 http://1.1.1.1/`,
      `env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy curl -sS --max-time 3 http://upstream.test:${listener.port}/`,
      `HTTP_PROXY=http://1.1.1.1:3128 http_proxy=http://1.1.1.1:3128 curl -sS --max-time 3 http://upstream.test:${listener.port}/`,
    ]) {
      const r = await s.run({ command })
      assert.notEqual(r.exitCode, 0, `${command} got out: ${r.stdout}`)
    }
    assert.equal(listener.hits, hits, 'nothing reached the host listener')
    // Twin: the same request through the gateway lands.
    assert.equal((await viaGateway(s)).stdout, '200')
    assert.equal(listener.hits, hits + 1)
  })

  test('the forwarder, its port and the gateway CA are out of the sandbox user’s reach', async () => {
    const s = await open()
    const forwarder = await s.run({ command: `pgrep -u 0 -f '[n]ode -e'` })
    assert.match(forwarder.stdout, /^\d+\n$/, 'the forwarder runs as root')
    const pid = forwarder.stdout.trim()
    for (const command of [
      `kill -9 ${pid}`,
      `kill -STOP ${pid}`,
      `cat /proc/${pid}/environ`,
      `node -e 'require("net").createServer().listen(${PROXY_PORT}, "127.0.0.1").on("error", (e) => { console.error(e.code); process.exit(1) })'`,
      `echo tampered >> ${CA_PATH}`,
      `echo tampered >> ${CA_BUNDLE}`,
    ]) {
      const r = await s.run({ command })
      assert.notEqual(r.exitCode, 0, `${command} succeeded as the sandbox user`)
    }
    assert.deepEqual(s.egress, { active: true })
    assert.equal((await viaGateway(s)).stdout, '200', 'the gateway still works')
    // Twin: as root (docker({ root: true })) the same kill stops the forwarder.
    const r = await open({ root: true })
    const rootPid = (await r.run({ command: `pgrep -f '[n]ode -e'` })).stdout.trim()
    assert.equal((await r.run({ command: `kill -9 ${rootPid}` })).exitCode, 0)
    for (let i = 0; i < 50 && r.egress?.active; i++) await new Promise((d) => setTimeout(d, 100))
    assert.equal(r.egress?.active, false)
  })

  test('a root: true sandbox is still detached from every network', async () => {
    const s = await open({ root: true })
    const hits = listener.hits
    const r = await s.run({ command: `curl -sS --noproxy '*' --max-time 3 http://1.1.1.1/` })
    assert.notEqual(r.exitCode, 0)
    const networks = spawnSync(
      'docker',
      ['inspect', '--format', '{{json .NetworkSettings.Networks}}', s.id],
      { encoding: 'utf8' },
    ).stdout
    assert.deepEqual(Object.keys(JSON.parse(networks) ?? {}), [])
    assert.equal(listener.hits, hits)
  })
})
