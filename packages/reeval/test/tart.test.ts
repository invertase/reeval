// The Tart sandbox's session on a fake `tart` (test/support/fake-tart.ts): cloning, booting,
// running commands over `tart exec` or SSH, the egress gateway, aborts and teardown.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { adapterVersion } from '@reeval/sandbox-docker'
import { fakeBootstrapScript } from '../src/harness/fake-bootstrap.ts'
import type { SandboxOptions } from '../src/sandbox/index.ts'
import {
  createTartSandbox,
  EXEC_PROBE_WITH_SSH_MS,
  execScript,
  memoryMb,
  removeRunVms,
  sshGuest,
  vmPrefix,
} from '../src/sandbox/tart.ts'
import { bakedTartImage, bakeTartImage, type TartBake, tartBake } from '../src/sandbox/tart-bake.ts'
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
      assert.equal(r.stdout, 'http://127.0.0.1:43128')
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
        /^InfraError: Can't keep API_KEY out of the sandbox: credential brokering could not start .*passwordless sudo/,
      )
      assert.deepEqual(vms(), [], 'and the clone is deleted')
    })
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
      assert.equal(r.stdout, `${box.workdir}\neval:http://127.0.0.1:43128`)
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

  test("streams a spawned process's output, and its kill stops what it started in the VM", async () => {
    const box = await createTartSandbox(vm(), options())
    try {
      const child = await box.network.spawn({
        command: 'echo started; sleep 31 & echo $! > ~/spawned; wait',
      })
      const reader = child.stdout.getReader()
      const first = await reader.read()
      assert.equal(new TextDecoder().decode(first.value), 'started\n')
      await eventually('the process started', () => existsSync(join(box.home, 'spawned')))
      const grandchild = Number(readFileSync(join(box.home, 'spawned'), 'utf8'))
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
        /^InfraError: Can't keep CURSOR_API_KEY out of the sandbox: credential brokering could not start/,
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
  const bake = tartBake({ kind: 'fake', bootstrap }) as TartBake
  const ctx = (lines: string[] = []) => ({
    digest: fakeDigest(IMAGE),
    signal: new AbortController().signal,
    log: (line: string) => lines.push(line),
  })
  let release = () => {}
  before(async () => {
    release = await holdLoopback()
  })
  after(async () => {
    try {
      for (const name of vms()) await tartCli(['delete', name])
    } finally {
      release()
    }
  })

  test("bakes the harness's bootstrap into a stopped clone named for it, once", async () => {
    const lines: string[] = []
    const clones = () => fake?.log().filter((l) => l.startsWith('clone ')).length ?? 0
    const before = clones()
    const first = await bakeTartImage(vm(), bake, ctx(lines))
    assert.equal(first.image, bakedTartImage(bake, IMAGE, fakeDigest(IMAGE)))
    assert.match(
      first.image,
      /^reeval-sandbox-fake-[0-9a-f]{8}-macos-sequoia-base-latest-[0-9a-f]{8}$/,
    )
    assert.equal(first.built, true)
    assert.deepEqual(vms(), [first.image], 'the bake VM is renamed, and nothing else is left')
    const home = join(fake?.dir ?? '', 'vms', first.image, 'home')
    assert.match(readFileSync(join(home, 'installed-in'), 'utf8'), /-bake-[0-9a-f]{6}\/home\n$/)
    assert.ok(!existsSync(join(fake?.dir ?? '', 'vms', first.image, 'running')), 'it is stopped')
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
      assert.equal(readFileSync(join(fake?.dir ?? '', 'vms', clone, 'image'), 'utf8'), `${image}\n`)
      assert.equal((await box.exec(fakeBootstrapScript(bootstrap))).exitCode, 0)
      assert.equal((await box.exec(fakeBootstrapScript('echo new >> installed-in'))).exitCode, 0)
      assert.match((await box.readFile('~/installed-in')) ?? '', /-bake-[0-9a-f]{6}\/home\nnew\n$/)
    } finally {
      await box.destroy()
    }
  })

  test('a bootstrap that fails leaves no VM behind, and names its exit', async () => {
    const broken = tartBake({ kind: 'fake', bootstrap: 'echo no network >&2; exit 7' }) as TartBake
    const before = vms()
    await assert.rejects(
      bakeTartImage(vm(), broken, ctx()),
      /^Error: The fake agent's bootstrap exited 7: no network$/,
    )
    assert.deepEqual(vms(), before)
  })

  test("the image's name moves with the base's digest, the harness's adapter and its patch", () => {
    const other = bakedTartImage(bake, IMAGE, fakeDigest('other'))
    assert.notEqual(other, bakedTartImage(bake, IMAGE, fakeDigest(IMAGE)))
    assert.equal(tartBake({ kind: 'fake' }), null)
    const cursor = tartBake({ kind: 'cursor' } as HarnessDescriptor)
    assert.deepEqual([cursor?.label, cursor?.pnpm], [`cursor-${adapterVersion('cursor')}`, true])
    assert.match(
      tartBake({ kind: 'claude-code' } as HarnessDescriptor)?.label ?? '',
      /^claude-code-[\d.]+-patch\.[0-9a-f]{8}$/,
    )
    assert.match(bakedTartImage({ label: 'pi-0.2.9' }, 'sequoia-dev', null), /^[\w.-]+$/)
  })
})

describe('Tart sandbox commands', () => {
  test('memory in megabytes, as tart set takes it', () => {
    assert.equal(memoryMb('8g'), 8192)
    assert.equal(memoryMb('4096m'), 4096)
    assert.equal(memoryMb(2 * 1024 ** 3), 2048)
    assert.equal(memoryMb('1.5g'), 1536)
  })

  test("a command's script quotes each value and drops names a shell can't export", () => {
    const script = execScript({
      command: 'npm test',
      cwd: "/Users/admin/it's",
      env: { A: "x'y", 'NOT-A-NAME': 'z' },
      pidFile: '/s/1.pid',
    })
    const [setup, command] = script.split('\n')
    assert.equal(command, 'npm test')
    assert.match(setup ?? '', /export A='x'\\''y'/)
    assert.match(setup ?? '', /cd '\/Users\/admin\/it'\\''s' \|\| exit 1/)
    assert.doesNotMatch(setup ?? '', /NOT-A-NAME/)
  })

  test('SSH gets one quoted command line', () => {
    assert.deepEqual(
      sshGuest('10.0.0.2', '/k', 'me').argv(['/bin/sh', '-c', 'echo "$HOME"']).slice(-2),
      ['me@10.0.0.2', `'/bin/sh' '-c' 'echo "$HOME"'`],
    )
  })
})
