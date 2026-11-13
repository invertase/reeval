// The Tart sandbox's session on a fake `tart` (test/support/fake-tart.ts): cloning, booting,
// running commands over `tart exec` or SSH, the egress gateway, aborts and teardown.
import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { resolveBridgePort } from '@ai-sdk/harness/utils'
import { adapterVersion, BRIDGE_PORT, bakeKey, PNPM_VERSION } from '@reeval/sandbox-docker'
import { fakeBootstrapScript } from '../src/harness/fake-bootstrap.ts'
import { type HarnessBake, harnessBake } from '../src/sandbox/harness-install.ts'
import type { SandboxOptions } from '../src/sandbox/index.ts'
import type { SandboxProvider } from '../src/sandbox/provider.ts'
import { bakedImage, createProviders } from '../src/sandbox/providers.ts'
import {
  createTartSandbox,
  EXEC_PROBE_WITH_SSH_MS,
  memoryMb,
  removeRunVms,
  sshGuest,
  tartSession,
  vmPrefix,
} from '../src/sandbox/tart.ts'
import {
  bakedTartImage,
  bakeTartImage,
  deleteBakedImages,
  tartBakeKey,
} from '../src/sandbox/tart-bake.ts'
import { tartCli } from '../src/sandbox/tart-cli.ts'
import type { HarnessDescriptor, TartSandboxDescriptor } from '../src/types.ts'
import { fakeDigest, holdLoopback, installFakeTart } from './support/fake-tart.ts'

const posix = process.platform !== 'win32'
const fake = posix ? installFakeTart() : undefined
const IMAGE = 'ghcr.io/cirruslabs/macos-sequoia-base:latest'

const options = (o: Partial<SandboxOptions> = {}): SandboxOptions => ({
  runId: 'run1',
  timeoutMs: 60_000,
  signal: new AbortController().signal,
  env: {},
  egress: { policy: 'allow-all', auto: [] },
  ...o,
})
const vm = (o: Partial<TartSandboxDescriptor> = {}): TartSandboxDescriptor => ({
  kind: 'tart',
  image: IMAGE,
  ...o,
})
const vms = () => readdirSync(join(fake?.dir ?? '', 'vms'))
const withEnv = async <T>(vars: Record<string, string>, body: () => Promise<T>) => {
  Object.assign(process.env, vars)
  try {
    return await body()
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k]
  }
}

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
const eventually = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(check(), what)
}

describe('the Tart sandbox', { skip: !posix && 'the fake tart is a bash script' }, () => {
  let release = () => {}
  before(async () => {
    release = await holdLoopback()
  })
  after(async () => {
    try {
      await removeRunVms('run1')
    } finally {
      release()
    }
  })

  test('clones the image, sizes and boots the clone, works in it, and deletes it', async () => {
    const box = await createTartSandbox(vm({ cpus: 2, memory: '4g' }), options())
    try {
      const [name = ''] = vms()
      assert.match(name, /^reeval-run1-[0-9a-f]{6}$/)
      assert.ok(fake?.log().includes(`clone ${IMAGE} ${name}`))
      assert.equal(
        readFileSync(join(fake?.dir ?? '', 'vms', name, 'set'), 'utf8').trim(),
        `${name} --cpu 2 --memory 4096`,
      )
      assert.equal(box.workdir, join(box.home, 'workspace'))
      const r = await box.exec('pwd; printf %s "$A"', { env: { A: 'one' } })
      assert.deepEqual([r.exitCode, r.stdout], [0, `${box.workdir}\none`])
      await box.writeFile('src/a.txt', 'hello')
      await box.writeFile('~/.config/x', new Uint8Array([104, 105]))
      assert.equal(await box.readFile('src/a.txt'), 'hello')
      assert.equal(await box.readFile('~/.config/x'), 'hi')
      assert.equal(await box.readFile('nope'), null)
      assert.equal((await box.exec('cat a.txt', { cwd: 'src' })).stdout, 'hello')
      assert.equal((await box.execOwn('pwd')).stdout.trim(), box.stateDir)
      assert.notEqual((await box.exec('exit 3')).exitCode, 0)
    } finally {
      await box.destroy()
      await box.destroy()
    }
    assert.deepEqual(vms(), [], 'the clone is deleted, once')
  })

  test("sends variables on stdin, so no value reaches a command line, and runs the eval's own", async () => {
    const box = await createTartSandbox(vm(), options({ env: { TOKEN: 'sk-sandbox-wide' } }))
    try {
      const r = await box.exec('printf %s "$TOKEN:$ONE"', { env: { ONE: "it's 'quoted'" } })
      assert.equal(r.stdout, "sk-sandbox-wide:it's 'quoted'")
      assert.ok(!fake?.log().some((line) => line.includes('sk-sandbox-wide')))
    } finally {
      await box.destroy()
    }
  })

  test('runs the egress gateway as root, and gives every command its proxy', async () => {
    const box = await createTartSandbox(vm(), options())
    try {
      const r = await box.exec('printf %s "$HTTPS_PROXY"')
      assert.equal(r.stdout, 'http://127.0.0.1:24128')
      assert.deepEqual(box.traffic?.(), { contacted: [], blocked: [], unresolved: [] })
      assert.match(
        (await box.getPortEndpoint?.({ port: 3000 }))?.url ?? '',
        /^http:\/\/127\.0\.0\.1:\d+$/,
      )
      assert.equal(
        (await box.execOwn('[ -n "$HTTPS_PROXY" ] && echo set || echo none')).stdout.trim(),
        'none',
      )
    } finally {
      await box.destroy()
    }
  })

  test('goes on without the gateway under allow-all, unless a secret is brokered', async () => {
    await withEnv({ FAKE_TART_NO_SUDO: '1' }, async () => {
      const box = await createTartSandbox(vm(), options())
      try {
        assert.equal(
          (await box.exec('[ -n "$HTTPS_PROXY" ] && echo set || echo none')).stdout.trim(),
          'none',
        )
        assert.equal(box.traffic, undefined)
        assert.equal((await box.getPortEndpoint?.({ port: 80 }))?.url, 'http://127.0.0.1:80')
      } finally {
        await box.destroy()
      }
      const secret = { name: 'API_KEY', placeholder: 'p', value: 'v', hosts: ['a.test'], in: [] }
      await assert.rejects(
        createTartSandbox(vm(), options({ substitutions: [{ ...secret, phase: 'agent' }] })),
        /^InfraError: Can't keep API_KEY out of the tart\(\) sandbox: credential brokering could not start .*passwordless sudo/,
      )
      assert.deepEqual(vms(), [], 'and the clone is deleted')
    })
  })

  test("fails a harness that trusts only the keychain when the gateway's CA can't go there", async () => {
    await withEnv({ FAKE_TART_NO_TRUST: '1' }, async () => {
      const box = await createTartSandbox(vm(), options())
      await box.destroy()
      await assert.rejects(
        createTartSandbox(vm(), options({ keychainTrust: true })).then(async (started) => {
          await started.destroy()
          return started
        }),
        /^InfraError: This harness's CLI trusts only the macOS keychain, .*The authorization was denied since no user interaction was possible.*com\.apple\.trust-settings\.admin allow$/,
      )
      assert.deepEqual(vms(), [], 'and the clone is deleted')
    })
    const box = await createTartSandbox(vm(), options({ keychainTrust: true }))
    await box.destroy()
  })

  test("gives a real harness the VM as its session, in the image user's home", async () => {
    const env = { A: 'eval', HTTPS_PROXY: 'http://eval.example:1' }
    const box = await createTartSandbox(vm(), options({ env }))
    try {
      const net = box.network
      assert.equal(net.defaultWorkingDirectory, box.home)
      assert.deepEqual(net.egress, { active: true })
      assert.equal(typeof net.addRequestTransformations, 'function')
      const r = await net.run({
        command: 'pwd; printf %s "$A:$HTTPS_PROXY"',
        workingDirectory: 'workspace',
      })
      assert.equal(r.stdout, `${box.workdir}\neval:http://127.0.0.1:24128`)
      const bundle = await net.run({ command: 'printf %s "$SSL_CERT_FILE:$GIT_SSL_CAINFO"' })
      const ca = join(box.stateDir, 'ca-bundle.pem')
      assert.equal(bundle.stdout, `${ca}:${ca}`)
      const pem = readFileSync(ca, 'utf8')
      assert.ok(pem.length > readFileSync(join(fake?.dir ?? '', 'ca', 'reeval-egress.crt')).length)
      assert.ok(
        pem
          .trimEnd()
          .endsWith(
            readFileSync(join(fake?.dir ?? '', 'ca', 'reeval-egress.crt'), 'utf8').trimEnd(),
          ),
        'the gateway CA after the system bundle',
      )
      await net.writeTextFile({ path: 'workspace/a.txt', content: 'hi' })
      assert.equal(await box.readFile('a.txt'), 'hi')
      assert.deepEqual(await net.stat({ path: 'workspace/a.txt' }), { type: 'file', size: 2 })
      assert.deepEqual(await net.listDirectory({ path: 'workspace' }), [
        { type: 'file', name: 'a.txt' },
      ])
      assert.equal(await net.deleteFile({ path: 'workspace/a.txt' }), true)
      assert.equal(await net.stat({ path: 'workspace/a.txt' }), null)
    } finally {
      await box.destroy()
    }
  })

  test('exposes the bridge port, and reaches a server on it in the VM through the gateway', async () => {
    const box = await createTartSandbox(vm(), options())
    try {
      const port = resolveBridgePort({ sandboxSession: box.network, portOverride: undefined })
      assert.equal(port, BRIDGE_PORT)
      const server = await box.network.spawn({
        command: `node -e "require('http').createServer((q, s) => s.end('bridge')).listen(${port}, '127.0.0.1', () => console.log('up'))"`,
      })
      try {
        const up = await server.stdout.getReader().read()
        assert.equal(new TextDecoder().decode(up.value).trim(), 'up')
        const { url } = await box.network.getPortEndpoint({ port, protocol: 'http' })
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
        assert.notEqual(new URL(url).port, String(port), 'through the gateway, not the port itself')
        assert.equal(await (await fetch(url)).text(), 'bridge')
      } finally {
        await server.kill()
      }
    } finally {
      await box.destroy()
    }
  })

  test("refuses a port once the gateway has stopped, rather than going to the VM's address", async () => {
    const stopped = 'the forwarder exited (1)'
    const gateway = {
      stopped,
      portUrl: async () => {
        throw new Error(`the egress gateway stopped: ${stopped}`)
      },
    } as unknown as Parameters<typeof tartSession>[0]['gateway']
    const session = tartSession({
      vm: 'reeval-gone',
      guest: sshGuest('192.0.2.1', '/nonexistent'),
      home: '/Users/admin',
      stateDir: '/Users/admin/.reeval-state',
      env: {},
      gateway,
      destroy: async () => {},
    })
    await assert.rejects(
      session.getPortEndpoint({ port: BRIDGE_PORT }),
      /^Error: the egress gateway stopped: the forwarder exited \(1\)$/,
    )
  })

  test("streams a spawned process's output, and its kill stops what it started in the VM", async () => {
    const box = await createTartSandbox(vm(), options())
    try {
      const child = await box.network.spawn({
        command: 'echo started; sleep 31 & echo $! > ~/spawned; wait',
      })
      const reader = child.stdout.getReader()
      const first = await reader.read()
      assert.equal(new TextDecoder().decode(first.value), 'started\n')
      const pidFile = join(box.home, 'spawned')
      // The shell creates the file before echo writes the pid, and alive(0) is always true.
      await eventually(
        'the process started',
        () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'),
      )
      const grandchild = Number(readFileSync(pidFile, 'utf8'))
      assert.ok(grandchild > 0)
      assert.ok(alive(grandchild))
      await child.kill()
      assert.notEqual((await child.wait()).exitCode, 0)
      await eventually('what it started was killed', () => !alive(grandchild))
    } finally {
      await box.destroy()
    }
  })

  test("a harness's brokered key fails the attempt when the gateway can't start", async () => {
    await withEnv({ FAKE_TART_NO_SUDO: '1' }, async () => {
      await assert.rejects(
        createTartSandbox(
          vm(),
          options({ brokering: { credential: 'CURSOR_API_KEY', endpoints: [] } }),
        ),
        /^InfraError: Can't keep CURSOR_API_KEY out of the tart\(\) sandbox: credential brokering could not start/,
      )
    })
    assert.deepEqual(vms(), [])
  })

  test('reaches an image without the Guest Agent over SSH, when the eval gave a key', async () => {
    await withEnv({ FAKE_TART_NO_AGENT: '1', FAKE_TART_NO_SUDO: '1' }, async () => {
      const box = await createTartSandbox(vm({ ssh: { key: '/k/id_ed25519' } }), options())
      try {
        assert.equal(
          (await box.exec('printf %s "$A"', { env: { A: 'over ssh' } })).stdout,
          'over ssh',
        )
        assert.ok(
          fake
            ?.log()
            .some((l) => l.startsWith('ssh -i /k/id_ed25519 ') && l.includes(' admin@127.0.0.1 ')),
        )
      } finally {
        await box.destroy()
      }
    })
  })

  test('an image without the Guest Agent reaches SSH soon, though tart exec blocks', async () => {
    await withEnv(
      { FAKE_TART_NO_AGENT: '1', FAKE_TART_EXEC_BLOCKS: '30', FAKE_TART_NO_SUDO: '1' },
      async () => {
        const started = Date.now()
        const box = await createTartSandbox(vm({ ssh: { key: '/k/id_ed25519' } }), options())
        try {
          assert.ok(
            Date.now() - started < EXEC_PROBE_WITH_SSH_MS + 5_000,
            `reached in ${Date.now() - started}ms`,
          )
          assert.equal((await box.exec('printf ok')).stdout, 'ok')
        } finally {
          await box.destroy()
        }
      },
    )
  })

  test('an abort kills the command and everything it started in the VM', async () => {
    const box = await createTartSandbox(vm(), options())
    try {
      const controller = new AbortController()
      const running = box.exec('sleep 30 & echo $! > ~/child; wait', { signal: controller.signal })
      await eventually('the command started', () => existsSync(join(box.home, 'child')))
      const child = Number(readFileSync(join(box.home, 'child'), 'utf8'))
      assert.ok(alive(child))
      controller.abort(new Error('canceled'))
      await assert.rejects(running, /canceled/)
      await eventually('its background process was killed', () => !alive(child))
    } finally {
      await box.destroy()
    }
  })

  test("a clone that doesn't boot fails the attempt as infrastructure, and is deleted", async () => {
    await withEnv({ FAKE_TART_RUN_FAILS: '1' }, async () => {
      await assert.rejects(
        createTartSandbox(vm(), options()),
        /^InfraError: reeval-run1-[0-9a-f]{6} didn't boot: tart run exited \(1\): no space for/,
      )
    })
    assert.deepEqual(vms(), [])
  })

  test("names VMs outside the run as the cause when macOS's VM limit refuses a clone", async () => {
    const refused = 'The number of VMs exceeds the system limit (other running VMs: mine-a, mine-b)'
    await withEnv({ FAKE_TART_RUN_FAILS: refused }, async () => {
      await assert.rejects(
        createTartSandbox(vm(), options()),
        /other running VMs: mine-a, mine-b\)\. macOS runs two macOS VMs at a time, and VMs outside this run hold the slots\. Stop them \(tart stop <name>\), or run fewer: tart\(\{ maxConcurrent: 1 \}\)$/,
      )
    })
    assert.deepEqual(vms(), [])
  })

  test("a second VM's gateway leaves the first VM's forwarder running", async () => {
    const first = await createTartSandbox(vm(), options())
    const second = await createTartSandbox(vm(), options())
    try {
      assert.match(
        (await first.getPortEndpoint?.({ port: 3000 }))?.url ?? '',
        /^http:\/\/127\.0\.0\.1:(?!3000$)\d+$/,
        'the first still tunnels through its gateway',
      )
    } finally {
      await first.destroy()
      await second.destroy()
    }
  })

  test('refuses an attempt under any egress but allow-all, before cloning', async () => {
    await assert.rejects(
      createTartSandbox(vm(), options({ egress: { policy: 'proxy', auto: [] } })),
      /^InfraError: tart\(\) runs under egress 'allow-all' only/,
    )
    assert.deepEqual(vms(), [])
  })

  test("cleanup deletes the run's leftover clones, and no other run's", async () => {
    const mine = await createTartSandbox(vm(), options())
    const theirs = await createTartSandbox(vm(), options({ runId: 'run2' }))
    try {
      await removeRunVms('run1')
      assert.deepEqual(
        vms().map((n) => n.slice(0, vmPrefix('run2').length)),
        [vmPrefix('run2')],
      )
    } finally {
      await mine.destroy()
      await theirs.destroy()
    }
  })
})

describe('baked Tart images', { skip: !posix && 'the fake tart is a bash script' }, () => {
  const bootstrap = 'echo "$HOME" > installed-in'
  const bake = harnessBake({ kind: 'fake', bootstrap }) as HarnessBake
  const harness: HarnessDescriptor = { kind: 'fake', bootstrap }
  const ctx = (lines: string[] = [], o: { force?: boolean; signal?: AbortSignal } = {}) => ({
    source: fakeDigest(IMAGE),
    signal: o.signal ?? new AbortController().signal,
    log: (line: string) => lines.push(line),
    ...(o.force && { force: true }),
  })
  const prepareCtx = (lines: string[] = []) => ({
    root: fake?.dir ?? '',
    signal: new AbortController().signal,
    log: (line: string) => lines.push(line),
    retry: <T>(step: () => Promise<T>) => step(),
  })
  const vmDir = (name: string) => join(fake?.dir ?? '', 'vms', name)
  const installedIn = (name: string) =>
    readFileSync(join(vmDir(name), 'home', 'installed-in'), 'utf8')
  /** A VM a bake started `ageMs` ago and a killed reeval left, stopped or running. */
  const leftover = (ageMs: number, running = false) => {
    const name = `reeval-sandbox-fake-00000000-x-00000000-bake-${(Date.now() - ageMs).toString(36)}-abcd`
    mkdirSync(join(vmDir(name), 'home'), { recursive: true })
    if (running) writeFileSync(join(vmDir(name), 'running'), '')
    return name
  }
  let release = () => {}
  before(async () => {
    release = await holdLoopback()
  })
  afterEach(async () => {
    for (const name of vms()) await tartCli(['delete', name])
  })
  after(() => release())

  test("bakes the harness's bootstrap into a stopped clone named for it, once", async () => {
    const lines: string[] = []
    const clones = () => fake?.log().filter((l) => l.startsWith('clone ')).length ?? 0
    const before = clones()
    const first = await bakeTartImage(vm(), bake, ctx(lines))
    assert.equal(first.image, await bakedTartImage(vm(), bake, fakeDigest(IMAGE)))
    assert.match(
      first.image,
      /^reeval-sandbox-fake-[0-9a-f]{8}-macos-sequoia-base-latest-[0-9a-f]{8}$/,
    )
    assert.equal(first.built, true)
    assert.deepEqual(vms(), [first.image], 'the bake VM is renamed, and nothing else is left')
    assert.match(installedIn(first.image), /-bake-[0-9a-z]{8,}-[0-9a-f]{4}\/home\n$/)
    assert.ok(!existsSync(join(vmDir(first.image), 'running')), 'it is stopped')
    assert.ok(lines.includes(`Baking the fake agent's bootstrap onto ${IMAGE} as ${first.image}`))
    assert.ok(!lines.some((l) => l.includes('pnpm')), 'a fake agent gets no pnpm')
    const again = await bakeTartImage(vm(), bake, ctx())
    assert.deepEqual(again, { image: first.image, built: false, agentVersion: null })
    assert.equal(clones() - before, 1)
  })

  test('an attempt clones the baked image, and its harness finds its bootstrap done', async () => {
    const { image } = await bakeTartImage(vm(), bake, ctx())
    const box = await createTartSandbox(vm(), options({ image }))
    try {
      const clone = vms().find((n) => n.startsWith(vmPrefix('run1'))) ?? ''
      assert.equal(readFileSync(join(vmDir(clone), 'image'), 'utf8'), `${image}\n`)
      assert.equal((await box.exec(fakeBootstrapScript(bootstrap))).exitCode, 0)
      assert.equal((await box.exec(fakeBootstrapScript('echo new >> installed-in'))).exitCode, 0)
      assert.match((await box.readFile('~/installed-in')) ?? '', /-bake-[0-9a-z-]+\/home\nnew\n$/)
    } finally {
      await box.destroy()
    }
  })

  test('a bootstrap that fails leaves no VM behind, and names its exit', async () => {
    const broken = harnessBake({
      kind: 'fake',
      bootstrap: 'echo no network >&2; exit 7',
    }) as HarnessBake
    await assert.rejects(
      bakeTartImage(vm(), broken, ctx()),
      /^Error: The fake agent's bootstrap exited 7: no network$/,
    )
    assert.deepEqual(vms(), [])
  })

  test('a bake canceled mid-bootstrap leaves no VM behind', async () => {
    const slow = harnessBake({ kind: 'fake', bootstrap: 'touch started; sleep 30' }) as HarnessBake
    const abort = new AbortController()
    const baking = bakeTartImage(vm(), slow, ctx([], { signal: abort.signal }))
    while (!vms().some((n) => existsSync(join(vmDir(n), 'home', 'started')))) {
      await new Promise((r) => setTimeout(r, 50))
    }
    abort.abort(new Error('canceled'))
    await assert.rejects(baking, /canceled/)
    assert.deepEqual(vms(), [])
  })

  test('a clone that fails leaves no partial VM behind', async () => {
    process.env.FAKE_TART_CLONE_FAILS = 'disk full'
    try {
      await assert.rejects(bakeTartImage(vm(), bake, ctx()), /Couldn't clone .*disk full/)
    } finally {
      delete process.env.FAKE_TART_CLONE_FAILS
    }
    assert.deepEqual(vms(), [])
  })

  test('another run naming the image first wins the race, and this bake is dropped', async () => {
    const image = await bakedTartImage(vm(), bake, fakeDigest(IMAGE))
    const racing: HarnessBake = {
      ...bake,
      install: async (session) => {
        await tartCli(['clone', IMAGE, image])
        return bake.install(session)
      },
    }
    const baked = await bakeTartImage(vm(), racing, ctx())
    assert.deepEqual([baked.image, baked.built], [image, true])
    assert.deepEqual(vms(), [image])
  })

  test('a local base rebakes once its disk changes', async () => {
    await tartCli(['clone', IMAGE, 'sequoia-dev'])
    const local = vm({ image: 'sequoia-dev' })
    const provider = createProviders({ pull: true }).tart as SandboxProvider<TartSandboxDescriptor>
    const first = bakedImage(await provider.prepare(local, harness, prepareCtx()))
    appendFileSync(join(vmDir('sequoia-dev'), 'disk.img'), 'Xcode\n')
    const second = bakedImage(await provider.prepare(local, harness, prepareCtx()))
    assert.ok(first && second)
    assert.notEqual(second, first)
    assert.ok(vms().includes(second))
  })

  test('--force pulls the tag again and bakes the image anew in its place', async () => {
    await tartCli(['pull', IMAGE])
    const first = await bakeTartImage(vm(), bake, ctx())
    const was = installedIn(first.image)
    const lines: string[] = []
    const provider = createProviders({ pull: true, force: true })
      .tart as SandboxProvider<TartSandboxDescriptor>
    const pulls = () => fake?.log().filter((l) => l === `pull ${IMAGE}`).length ?? 0
    const pulled = pulls()
    const handle = await provider.prepare(vm(), harness, prepareCtx(lines))
    assert.equal(bakedImage(handle), first.image)
    assert.equal(pulls() - pulled, 1)
    assert.notEqual(installedIn(first.image), was, 'baked again')
    assert.deepEqual(vms(), [first.image])
  })

  test('a bake deletes the bake VMs a killed reeval left, once they are old', async () => {
    const stale = leftover(11 * 60_000)
    const staleRunning = leftover(61 * 60_000, true)
    const fresh = leftover(60_000)
    const freshRunning = leftover(30 * 60_000, true)
    const lines: string[] = []
    const { image } = await bakeTartImage(vm(), bake, ctx(lines))
    assert.deepEqual(vms().sort(), [fresh, freshRunning, image].sort())
    assert.ok(lines.includes(`Deleted ${stale}, a bake reeval didn't finish`))
    assert.ok(lines.includes(`Deleted ${staleRunning}, a bake reeval didn't finish`))
  })

  test('a new bake names the older bakes of its harness onto the same image', async () => {
    const older = 'reeval-sandbox-fake-11111111-macos-sequoia-base-latest-00000000'
    const elsewhere = 'reeval-sandbox-fake-11111111-macos-tahoe-base-latest-00000000'
    for (const name of [older, elsewhere]) mkdirSync(join(vmDir(name), 'home'), { recursive: true })
    const lines: string[] = []
    await bakeTartImage(vm(), bake, ctx(lines))
    assert.ok(
      lines.some((l) =>
        l.startsWith(
          `Older bakes of the fake agent's bootstrap onto ${IMAGE}: ${older}. reeval clean --images`,
        ),
      ),
      lines.join('\n'),
    )
  })

  test('reeval clean --images deletes the baked images that are not running, and nothing else', async () => {
    const { image } = await bakeTartImage(vm(), bake, ctx())
    const running = 'reeval-sandbox-fake-22222222-macos-sequoia-base-latest-00000000'
    mkdirSync(join(vmDir(running), 'home'), { recursive: true })
    writeFileSync(join(vmDir(running), 'running'), '')
    await tartCli(['clone', IMAGE, 'my-own-vm'])
    const bakeVm = leftover(0)
    assert.deepEqual(await deleteBakedImages(), [image])
    assert.deepEqual(vms().sort(), [bakeVm, 'my-own-vm', running].sort())
  })

  test("the image's name moves with the base, the user, the recipe, the adapter and its patch", async () => {
    const name = (o: Partial<TartSandboxDescriptor> = {}, b = bake, source = fakeDigest(IMAGE)) =>
      bakedTartImage(vm(o), b, source)
    const base = await name()
    assert.ok(
      base.endsWith(`-${bakeKey(PNPM_VERSION, IMAGE, fakeDigest(IMAGE), '', await bake.recipe())}`),
      `${base} ends with the bake key Docker's from-images use`,
    )
    assert.notEqual(await name({}, bake, fakeDigest('other')), base)
    assert.notEqual(await name({ ssh: { key: '/k', user: 'me' } }), base)
    assert.notEqual(await name({}, { ...bake, recipe: async () => 'other' }), base)
    assert.notEqual(
      tartBakeKey(vm({ ssh: { key: '/k', user: 'me' } }), harness),
      tartBakeKey(vm(), harness),
    )
    assert.equal(harnessBake({ kind: 'fake' }), null)
    const cursor = harnessBake({ kind: 'cursor' } as HarnessDescriptor)
    assert.deepEqual([cursor?.label, cursor?.pnpm], [`cursor-${adapterVersion('cursor')}`, true])
    assert.match((await cursor?.recipe()) ?? '', /^[0-9a-f]{16}$/)
    assert.match(
      harnessBake({ kind: 'claude-code' } as HarnessDescriptor)?.label ?? '',
      /^claude-code-[\d.]+-patch\.[0-9a-f]{8}$/,
    )
    assert.match(await name({ image: 'sequoia-dev' }, bake, 'local:-'), /^[\w.-]+$/)
  })
})

describe('Tart sandbox commands', () => {
  test('memory in megabytes, as tart set takes it', () => {
    assert.equal(memoryMb('8g'), 8192)
    assert.equal(memoryMb('4096m'), 4096)
    assert.equal(memoryMb(2 * 1024 ** 3), 2048)
    assert.equal(memoryMb('1.5g'), 1536)
  })

  test('SSH gets one quoted command line', () => {
    assert.deepEqual(
      sshGuest('10.0.0.2', '/k', 'me').argv(['/bin/sh', '-c', 'echo "$HOME"']).slice(-2),
      ['me@10.0.0.2', `'/bin/sh' '-c' 'echo "$HOME"'`],
    )
  })
})
