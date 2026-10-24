// What confines a sandbox container: the unprivileged user, no capabilities it can use,
// no-new-privileges, and memory, CPU and process limits; root's privileged execs, confined by
// seccomp and AppArmor; and that, as that user, the agent can't get around or reconfigure the
// egress gateway. Each probe has a twin that must see the opposite, so it can fail.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import type net from 'node:net'
import { after, before, describe, test } from 'node:test'
import { buildInstallLayer } from '../src/build-image.ts'
import { dockerCapacity, imageInfo } from '../src/docker-cli.ts'
import { CA_BUNDLE, CA_PATH, PROXY_PORT } from '../src/egress/gateway.ts'
import {
  DEFAULT_IMAGE,
  SANDBOX_HOME,
  SANDBOX_ROOT,
  SANDBOX_STATE,
  SANDBOX_USER,
} from '../src/image.ts'
import {
  DEFAULT_LIMITS,
  type DockerSession,
  PRIVILEGED_CAPABILITIES,
  type SessionOptions,
} from '../src/session.ts'
import { CLI, createSession, ENGINE, REQUIRE_ENGINE } from './engine.ts'

const dockerReady =
  REQUIRE_ENGINE ||
  (() => {
    try {
      execFileSync(CLI, ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

/** reeval's image with iptables and iproute2, built once (as root, like every image build). */
const NET_TOOLS_IMAGE = `reeval-test-net-tools:${DEFAULT_IMAGE.split(':')[1]}`

/** Capability bits, from linux/capability.h. */
const CAP = {
  CHOWN: 0,
  DAC_OVERRIDE: 1,
  DAC_READ_SEARCH: 2,
  FOWNER: 3,
  SETGID: 6,
  SETUID: 7,
  NET_RAW: 13,
} as const
const mask = (...bits: number[]) => bits.reduce((m, b) => m | (1n << BigInt(b)), 0n)
/** Every container's bounding set: what runPrivileged's root execs hold. */
const PRIVILEGED = mask(...PRIVILEGED_CAPABILITIES.map((c) => CAP[c]))

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
    const s = await createSession({ image: DEFAULT_IMAGE, ...options })
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

  test("runPrivileged reads what the sandbox user keeps to itself, and runs none of that user's binaries", async () => {
    const s = await open()
    await s.run({
      command: `echo mine > private.txt && chmod 600 private.txt && mkdir -p ~/.local/bin && printf '#!/bin/sh\\necho planted\\n' > ~/.local/bin/git && chmod +x ~/.local/bin/git`,
    })
    // Twin: the sandbox user's own PATH finds the planted git.
    assert.equal((await s.run({ command: 'git --version' })).stdout.trim(), 'planted')
    const r = await s.runPrivileged({
      command: `echo "$(id -u) $(pwd) $(cat ${SANDBOX_ROOT}/private.txt) $(git --version | cut -d" " -f1-2)"`,
    })
    assert.equal(r.stdout.trim(), `0 ${SANDBOX_STATE} mine git version`, r.stderr)
    assert.equal(
      (await s.run({ command: `stat -c '%u %a' ${SANDBOX_STATE}` })).stdout.trim(),
      '0 700',
    )
  })

  test('runPrivileged is root with only the privileged capabilities, under seccomp and AppArmor', async () => {
    const s = await open()
    const status = (await s.runPrivileged({ command: 'cat /proc/self/status' })).stdout
    const field = (name: string) => new RegExp(`^${name}:\\s+(\\S+)$`, 'm').exec(status)?.[1]
    assert.equal(BigInt(`0x${field('CapEff')}`), PRIVILEGED)
    assert.equal(BigInt(`0x${field('CapBnd')}`), PRIVILEGED)
    assert.equal(field('NoNewPrivs'), '1')
    assert.equal(field('Seccomp'), '2', 'a seccomp filter applies')
    // Twin: the sandbox user's own commands run under the same AppArmor profile, whichever the
    // host has (`exec --privileged` is `unconfined`).
    const profile = 'cat /proc/self/attr/current 2>/dev/null || echo none'
    assert.equal(
      (await s.runPrivileged({ command: profile })).stdout,
      (await s.run({ command: profile })).stdout,
    )
  })

  test("the sandbox user can't use the privileged capabilities, even through a setuid binary", async () => {
    const s = await open()
    await s.run({ command: 'echo mine > mine.txt' })
    const made = await s.runPrivileged({
      command: `mkdir -m 700 /root-only && echo secret > /root-only/secret && chmod 600 /root-only/secret && cp /bin/cat /usr/local/bin/rootcat && chmod 4755 /usr/local/bin/rootcat`,
    })
    assert.equal(made.exitCode, 0, made.stderr)
    for (const command of [
      'cat /root-only/secret',
      'ls /root-only',
      'rootcat /root-only/secret',
      `chown 0:0 ${SANDBOX_ROOT}/mine.txt`,
      'chown 10001 /usr/local/bin/rootcat',
      'chmod 777 /usr/local/bin/rootcat',
      'touch /etc/reeval-test',
      `ls ${SANDBOX_STATE}`,
    ]) {
      const r = await s.run({ command })
      assert.notEqual(r.exitCode, 0, `${command} succeeded as the sandbox user`)
      assert.match(r.stderr, /not permitted|Permission denied/i, command)
    }
    // Twin: the same reads and chown as root through runPrivileged succeed.
    const r = await s.runPrivileged({
      command: `cat /root-only/secret && chown 0:0 ${SANDBOX_ROOT}/mine.txt && stat -c %u ${SANDBOX_ROOT}/mine.txt`,
    })
    assert.equal(r.stdout, 'secret\n0\n', r.stderr)
  })

  test('no capabilities, and no-new-privileges; root: true adds back only what apt-get needs', async () => {
    const s = await open()
    const p = await privileges(s)
    assert.deepEqual(
      [p.effective, p.permitted, p.bounding, p.ambient, p.noNewPrivs],
      [0n, 0n, PRIVILEGED, 0n, '1'],
    )
    assert.equal((await s.run({ command: 'test -e /var/run/docker.sock' })).exitCode, 1)

    // Twins: an added capability shows up in the same probe, and root gets exactly its set.
    const raw = await privileges(await open({ capabilities: ['NET_RAW'] }))
    assert.equal(raw.bounding, PRIVILEGED | mask(CAP.NET_RAW))
    const r = await open({ root: true })
    const rp = await privileges(r)
    const rootSet =
      PRIVILEGED | mask(CAP.CHOWN, CAP.DAC_OVERRIDE, CAP.FOWNER, CAP.SETGID, CAP.SETUID)
    assert.equal(rp.effective, rootSet)
    assert.equal(rp.bounding, rootSet)
    assert.equal(rp.noNewPrivs, '1')
  })

  test('default limits: memory with as much swap on top, CPUs and processes', async () => {
    const s = await open()
    const cpus = Math.min(DEFAULT_LIMITS.cpus, (await dockerCapacity(ENGINE))?.cpus ?? Infinity)
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
    const host = (await dockerCapacity(ENGINE))?.cpus
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

  test('oomKills counts the processes the kernel killed at the memory limit', async () => {
    const s = await open({ limits: { memory: '128m' } })
    // Twin: an exit 137 from a plain SIGKILL isn't an OOM kill.
    assert.equal((await s.run({ command: 'kill -9 $$' })).exitCode, 137)
    assert.equal(await s.oomKills(), 0)
    assert.equal((await s.run({ command: allocate(512) })).exitCode, 137)
    assert.equal(await s.oomKills(), 1)
  })

  test('install layers put ~ in the sandbox user’s home, owned by it', async () => {
    const parent = {
      ref: DEFAULT_IMAGE,
      id: (await imageInfo(DEFAULT_IMAGE, ENGINE))?.id ?? '',
    }
    const tag = await buildInstallLayer(
      parent,
      [
        {
          run: 'test "$(id -u)" = 0 && mkdir -p ~/.tool/bin && printf "#!/bin/sh\\necho tool ok\\n" > ~/.tool/bin/t && chmod +x ~/.tool/bin/t',
        },
      ],
      { engine: ENGINE },
    )
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
    const s = await createSession({
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
    execFileSync(CLI, ['build', '-q', '-t', NET_TOOLS_IMAGE, '-'], {
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
      CLI,
      ['inspect', '--format', '{{json .NetworkSettings.Networks}}', s.id],
      { encoding: 'utf8' },
    ).stdout
    assert.deepEqual(Object.keys(JSON.parse(networks) ?? {}), [])
    assert.equal(listener.hits, hits)
  })
})
