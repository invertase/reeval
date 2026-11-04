// `tart({ hosts })`: each Mac as `ssh` reaches it, preflight's one check of each, and which host an
// attempt's VM starts on, against fake Macs that a fake `ssh` reaches (test/support/fake-tart.ts).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseTartHost, tartHostsCapacity, tartHostsProblem } from '../src/contract/tart.ts'
import { preparedHosts, tartProvider } from '../src/sandbox/providers.ts'
import { bootOnHost, bootTartVm, removeRunVms, vmPrefix } from '../src/sandbox/tart.ts'
import { tartCli } from '../src/sandbox/tart-cli.ts'
import {
  claimHost,
  freeSlots,
  HostRefusal,
  hostLoad,
  hostSsh,
  hostTarget,
  probeHost,
  TartBusyError,
} from '../src/sandbox/tart-hosts.ts'
import { tartDigestOn, tartSourceOn } from '../src/sandbox/tart-images.ts'
import { InfraError } from '../src/sandbox/types.ts'
import type { TartSandboxDescriptor } from '../src/types.ts'
import { project, runCli } from './helpers.ts'
import { fakeDigest, fakeTartHosts, holdLoopback } from './support/fake-tart.ts'
import { SEEDED_RUN_ID, writeStoppedStaging } from './support/resume.ts'

const posix = process.platform !== 'win32'
const SEQUOIA = 'ghcr.io/cirruslabs/macos-sequoia-base:15.6'

/** A host spec parsed, which must parse. */
const parsed = (spec: Parameters<typeof parseTartHost>[0]) => {
  const p = parseTartHost(spec)
  assert.notEqual(typeof p, 'string', String(p))
  return p as Exclude<typeof p, string>
}

/** Runs `fn` with the fake's variables on this process, as a worker would have them. */
async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const was = { ...process.env }
  Object.assign(process.env, env)
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(env)) {
      if (was[key] === undefined) delete process.env[key]
      else process.env[key] = was[key]
    }
  }
}

describe('a host of tart({ hosts })', () => {
  test('an alias, user@host, an ssh:// URL or its parts; 2 VMs each by default', () => {
    assert.deepEqual(parsed('mac-studio'), { label: 'mac-studio', host: 'mac-studio', vms: 2 })
    assert.deepEqual(parsed('elliot@mac-mini.local'), {
      label: 'elliot@mac-mini.local',
      host: 'mac-mini.local',
      user: 'elliot',
      vms: 2,
    })
    assert.deepEqual(parsed('ssh://ci@10.0.0.5:2222'), {
      label: 'ssh://ci@10.0.0.5:2222',
      host: '10.0.0.5',
      user: 'ci',
      port: 2222,
      vms: 2,
    })
    assert.deepEqual(parsed('ssh://[fe80::1]'), {
      label: 'ssh://[fe80::1]',
      host: 'fe80::1',
      vms: 2,
    })
    assert.deepEqual(
      parsed({ host: 'mac-mini', user: 'ci', port: 22, identityFile: '~/.ssh/id_ed25519', vms: 1 }),
      {
        label: 'ci@mac-mini:22',
        host: 'mac-mini',
        user: 'ci',
        port: 22,
        identityFile: '~/.ssh/id_ed25519',
        vms: 1,
      },
    )
    assert.equal(tartHostsCapacity(['a', { host: 'b', vms: 1 }]), 3)
  })

  test('refuses what plain ssh would read another way, passwords and the same Mac twice', () => {
    const refusals: Array<[Parameters<typeof tartHostsProblem>[0], RegExp]> = [
      [[], /names no host/],
      [['-oProxyCommand=x'], /isn't an SSH destination/],
      [['mac studio'], /isn't an SSH destination/],
      [['mac-studio:2222'], /ssh takes no port in a destination; write ssh:\/\/mac-studio:2222/],
      [['ssh://ci:hunter2@mac'], /has a password/],
      [['ssh://mac/path'], /has a path/],
      [[{ host: 'ci@mac' }], /with no user, port or spaces/],
      [[{ host: 'mac', port: 70000 }], /port is a whole number from 1 to 65535/],
      [[{ host: 'mac', identityFile: 'keys/id' }], /absolute or starting ~\//],
      [[{ host: 'mac', vms: 3 }], /vms is 1 or 2/],
      [['mac', 'other', { host: 'mac' }], /entries 1 and 3 are the same Mac, mac/],
    ]
    for (const [hosts, problem] of refusals) {
      assert.match(tartHostsProblem(hosts) ?? '', problem, JSON.stringify(hosts))
    }
    assert.equal(tartHostsProblem(['mac', 'ci@mac', 'ssh://mac:2222']), undefined)
  })

  test('is reached with plain ssh, no prompt, the config applying; its parts as flags', () => {
    const argv = hostSsh(
      parsed({ host: 'mac-mini', user: 'ci', port: 2222, identityFile: '/k/id', vms: 1 }),
    )
    assert.equal(argv[0], 'ssh')
    assert.ok(!argv.includes('-F'), "the user's ~/.ssh/config applies, for aliases")
    for (const option of ['BatchMode=yes', 'ConnectTimeout=15']) {
      assert.ok(argv.includes(option), option)
    }
    assert.deepEqual(argv.slice(-10), [
      '-p',
      '2222',
      '-i',
      '/k/id',
      '-o',
      'IdentitiesOnly=yes',
      '-l',
      'ci',
      '--',
      'mac-mini',
    ])
    // A ProxyCommand's own ssh keeps its ControlPath's %C for itself: the outer ssh refuses it.
    const proxy = hostTarget(parsed('mac-mini')).proxy ?? ''
    assert.doesNotMatch(proxy.replaceAll('%%', ''), /%[^hp]/, proxy)
    // The login shell reads one line: every argument quoted, Homebrew's tart on PATH.
    const tart = hostTarget(parsed('mac-mini')).tart(['exec', '-i', 'vm', 'echo', "it's"])
    assert.match(tart.at(-1) ?? '', /^'\/bin\/sh' '-c' 'PATH=\/opt\/homebrew\/bin:/)
    assert.match(tart.at(-1) ?? '', /'exec' '-i' 'vm' 'echo' 'it'\\''s'$/)
  })

  const ssh = spawnSync('ssh', ['-V']).status === 0
  test('its ProxyCommand runs under a real ssh, which expands only its own tokens', {
    skip: (!posix || !ssh) && 'no ssh on this machine',
  }, () => {
    const home = mkdtempSync(join(tmpdir(), 'reeval-proxy-home-'))
    const was = process.env.HOME
    process.env.HOME = home
    try {
      const { proxy } = hostTarget(parsed('reeval-proxy-test.invalid'))
      const r = spawnSync(
        'ssh',
        [
          '-F',
          'none',
          '-o',
          'BatchMode=yes',
          '-o',
          `ProxyCommand=${proxy}`,
          'guest.invalid',
          'true',
        ],
        { encoding: 'utf8', timeout: 30_000 },
      )
      assert.doesNotMatch(r.stderr, /percent_expand|unknown key/, r.stderr)
      assert.match(r.stderr, /Could not resolve hostname reeval-proxy-test\.invalid/, r.stderr)
    } finally {
      process.env.HOME = was
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('shares one connection through a socket in a directory only this user can enter', {
    skip: !posix && 'ssh has no ControlMaster on Windows',
  }, () => {
    // Not under macOS's long $TMPDIR, where ~/.ssh/reeval/%C would be too long for a socket.
    const home = mkdtempSync('/tmp/reeval-ch-')
    const was = process.env.HOME
    process.env.HOME = home
    try {
      const dir = join(home, '.ssh', 'reeval')
      assert.ok(hostSsh(parsed('mac')).includes(`ControlPath=${dir}/%C`))
      assert.equal(statSync(dir).mode & 0o777, 0o700)
      chmodSync(dir, 0o777)
      const open = hostSsh(parsed('mac'))
      assert.ok(!open.includes(`ControlPath=${dir}/%C`), 'another user could stand in there')
      assert.ok(open.includes(`ControlPath=/tmp/reeval-${process.getuid?.()}/%C`), open.join(' '))
    } finally {
      process.env.HOME = was
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("its socket is in /tmp/reeval-<uid> when a long home leaves ~/.ssh/reeval's too long", {
    skip: !posix && 'ssh has no ControlMaster on Windows',
  }, () => {
    const home = join(mkdtempSync(join(tmpdir(), 'reeval-long-home-')), 'h'.repeat(80))
    mkdirSync(home)
    const was = process.env.HOME
    process.env.HOME = home
    try {
      const argv = hostSsh(parsed('mac'))
      const shared = `/tmp/reeval-${process.getuid?.()}`
      assert.ok(argv.includes(`ControlPath=${shared}/%C`), argv.join(' '))
      assert.ok(!existsSync(join(home, '.ssh', 'reeval')), 'no directory for a socket ssh refuses')
      const st = statSync(shared)
      assert.equal(st.uid, process.getuid?.())
      assert.equal(st.mode & 0o077, 0, 'only this user can enter it')
    } finally {
      process.env.HOME = was
      rmSync(join(home, '..'), { recursive: true, force: true })
    }
  })
})

describe('free slots on a host', () => {
  const vm = (own: boolean, running: boolean, os = 'darwin') => ({ name: 'x', own, running, os })
  test("its vms less reeval's macOS VMs, and no more than macOS's two less the others running", () => {
    assert.equal(freeSlots(2, []), 2)
    assert.equal(freeSlots(1, []), 1)
    assert.equal(freeSlots(2, [vm(true, true)]), 1)
    assert.equal(freeSlots(2, [vm(true, false)]), 1, 'a clone about to boot holds its slot')
    assert.equal(freeSlots(2, [vm(false, true)]), 1, "another app's VM takes macOS's slot")
    assert.equal(freeSlots(2, [vm(false, false)]), 2, 'a stopped VM of another app takes none')
    assert.equal(freeSlots(2, [vm(true, true), vm(false, true)]), 0)
    assert.equal(freeSlots(2, [vm(true, true, 'linux'), vm(false, true, 'linux')]), 2, 'Linux')
  })
})

describe('preflight on each host', { skip: !posix && 'the fake ssh is a bash script' }, () => {
  test('answers with the VMs it has room for, or skips a full or small Mac, saying why', async () => {
    const fake = fakeTartHosts({
      roomy: {},
      full: { freeKb: 10_000_000 },
      small: { memsize: 8 * 1024 ** 3 },
      tight: { memsize: 16 * 1024 ** 3 },
    })
    await withEnv(fake.env, async () => {
      assert.deepEqual(await probeHost(parsed('roomy'), {}), {
        ok: true,
        host: parsed('roomy'),
        vms: 2,
      })
      const full = await probeHost(parsed('full'), {})
      assert.equal(full.ok, false)
      assert.match(
        full.ok ? '' : full.skip,
        /^tart\(\) host full skipped: 10 GB free in .*hosts\/full, and reeval wants 25 GB/,
      )
      const small = await probeHost(parsed('small'), {})
      assert.match(
        small.ok ? '' : small.skip,
        /^tart\(\) host small skipped: it has 8 GB of memory, and one VM of 8 GB needs 12 GB/,
      )
      const tight = await probeHost(parsed('tight'), {})
      assert.ok(tight.ok)
      assert.equal(tight.vms, 1)
      assert.match(tight.note ?? '', /runs 1 VM at a time, not 2/)
      const sized = await probeHost(parsed('tight'), { memory: '4g' })
      assert.ok(sized.ok && sized.vms === 2, 'two VMs of 4 GB fit in 16 GB')
    })
  })

  test('refuses a Mac it cannot reach, one without tart, and one that is not a Mac', async () => {
    const fake = fakeTartHosts({ gone: { unreachable: true }, linux: { system: 'Linux-x86_64' } })
    await withEnv(fake.env, async () => {
      await assert.rejects(
        probeHost(parsed('elliot@gone'), {}),
        (error: Error) =>
          error instanceof HostRefusal &&
          /^tart\(\) host elliot@gone doesn't answer over SSH: ssh: Could not resolve hostname gone.*check that ssh elliot@gone true works.*passwords aren't supported/.test(
            error.message,
          ),
      )
      await assert.rejects(probeHost(parsed('nowhere'), {}), /host nowhere doesn't answer over SSH/)
      await assert.rejects(
        probeHost(parsed('linux'), {}),
        /host linux is Linux-x86_64: Tart runs macOS VMs on a Mac with Apple Silicon/,
      )
    })
    // A PATH with the fake ssh and nothing else of the fake's: the Mac has no tart.
    const bare = fakeTartHosts({ bare: {} })
    const only = join(bare.dir, 'only-ssh')
    mkdirSync(only)
    copyFileSync(join(bare.dir, 'bin', 'ssh'), join(only, 'ssh'))
    chmodSync(join(only, 'ssh'), 0o755)
    await withEnv({ ...bare.env, PATH: `${only}:/usr/bin:/bin` }, async () => {
      await assert.rejects(probeHost(parsed('bare'), {}), /host bare has no tart command/)
    })
  })

  test("reads an image's digest and a local VM's files there", async () => {
    const fake = fakeTartHosts({ mac: { images: [SEQUOIA] } })
    await withEnv(fake.env, async () => {
      const on = hostTarget(parsed('mac'))
      assert.equal(await tartDigestOn(SEQUOIA, on), fakeDigest(SEQUOIA))
      assert.equal(await tartDigestOn('ghcr.io/cirruslabs/other:1', on), null)
      assert.equal(await tartSourceOn('dev-vm', on), null, 'no such VM')
      await tartCli(['clone', SEQUOIA, 'dev-vm'], { on })
      assert.match((await tartSourceOn('dev-vm', on)) ?? '', /^local:-,\d+:\d+,-$/)
    })
  })
})

describe('the host an attempt starts on', {
  skip: !posix && 'the fake ssh is a bash script',
}, () => {
  test("counts reeval's VMs on each host and takes the one with room", async () => {
    const fake = fakeTartHosts({ a: {}, b: {} })
    // a already runs one of reeval's VMs, and a Linux VM of another app that counts for nothing.
    for (const [vm, os] of [
      ['reeval-run1-aaaaaa', 'darwin'],
      ['ubuntu', 'linux'],
    ]) {
      mkdirSync(join(fake.dir, 'hosts', 'a', 'vms', vm), { recursive: true })
      writeFileSync(join(fake.dir, 'hosts', 'a', 'vms', vm, 'running'), '')
      writeFileSync(join(fake.dir, 'hosts', 'a', 'vms', vm, 'os'), os)
    }
    // b keeps a stopped VM a killed run left behind, which holds no slot.
    mkdirSync(join(fake.dir, 'hosts', 'b', 'vms', 'reeval-run0-dead00'), { recursive: true })
    await withEnv(fake.env, async () => {
      const a = hostTarget(parsed({ host: 'a', vms: 1 }))
      const b = hostTarget(parsed({ host: 'b', vms: 1 }))
      const prefix = 'reeval-run1-'
      assert.deepEqual(
        (await hostLoad(a, prefix)).map((vm) => [vm.name, vm.own, vm.os]),
        [
          ['reeval-run1-aaaaaa', true, 'darwin'],
          ['ubuntu', false, 'linux'],
        ],
      )
      assert.deepEqual(await hostLoad(b, prefix), [], "another run's stopped VM isn't counted")
      const slots = [
        { target: a, vms: 1, image: SEQUOIA },
        { target: b, vms: 1, image: SEQUOIA },
      ]
      const signal = AbortSignal.timeout(30_000)
      for (let i = 0; i < 5; i++) {
        const pick = await claimHost(slots, { signal, busy: new Map(), prefix })
        assert.equal(pick.target.label, 'b')
      }
      const busy = new Map([['b', Date.now() + 60_000]])
      // a is full of this run's own VM, which ends: it waits however long, and isn't an infra error.
      const abort = new AbortController()
      setTimeout(() => abort.abort(new Error('waited')), 300)
      await assert.rejects(
        claimHost(slots, { signal: abort.signal, busy, prefix, deadline: { at: 0 } }),
        /waited/,
      )
      // Full of VMs outside the run, past the attempt's deadline: an infra error.
      mkdirSync(join(fake.dir, 'hosts', 'a', 'vms', 'dev-mac'))
      writeFileSync(join(fake.dir, 'hosts', 'a', 'vms', 'dev-mac', 'running'), '')
      await assert.rejects(
        claimHost(slots, { signal, busy, prefix: 'reeval-run2-', deadline: { at: 0 } }),
        (error: Error) =>
          error instanceof InfraError && /at its VM limit for 20 minutes/.test(error.message),
      )
    })
  })

  test('a host at its VM limit is busy, and leaves nothing behind', async () => {
    const release = await holdLoopback()
    try {
      const fake = fakeTartHosts({ full: { images: [SEQUOIA], limit: 0 } })
      await withEnv(fake.env, async () => {
        const on = hostTarget(parsed('full'))
        await assert.rejects(
          bootTartVm(
            { kind: 'tart', image: SEQUOIA },
            SEQUOIA,
            'reeval-r-1',
            AbortSignal.timeout(30_000),
            on,
          ),
          (error: Error) =>
            error instanceof TartBusyError &&
            /^full is at its VM limit: tart run exited \(1\): The number of VMs exceeds the system limit$/.test(
              error.message,
            ),
        )
        assert.deepEqual(fake.vms('full'), [], 'the clone is deleted')
        assert.deepEqual(
          fake.log().filter((l) => /^(clone|run) /.test(l)),
          [],
          'nothing ran on this machine',
        )
      })
    } finally {
      release()
    }
  })

  test("a run's cleanup deletes its VMs on every host", async () => {
    const fake = fakeTartHosts({ a: {}, b: {} })
    for (const [host, vm] of [
      ['a', 'reeval-run9-000001'],
      ['b', 'reeval-run9-000002'],
      ['b', 'reeval-other-000003'],
    ] as const) {
      mkdirSync(join(fake.dir, 'hosts', host, 'vms', vm), { recursive: true })
    }
    await withEnv(fake.env, async () => {
      await removeRunVms('run9', [hostTarget(parsed('a')), hostTarget(parsed('b'))])
    })
    assert.deepEqual(fake.vms('a'), [])
    assert.deepEqual(fake.vms('b'), ['reeval-other-000003'])
  })

  const onHosts = (hosts: TartSandboxDescriptor['hosts']): TartSandboxDescriptor => ({
    kind: 'tart',
    image: SEQUOIA,
    hosts,
  })

  test('a refusal tart run prints after it exits still reads as the host being busy', async () => {
    const release = await holdLoopback()
    try {
      const fake = fakeTartHosts({ late: { images: [SEQUOIA], limit: 0, refusesLate: true } })
      await withEnv(fake.env, async () => {
        const on = hostTarget(parsed('late'))
        const signal = AbortSignal.timeout(30_000)
        await assert.rejects(
          bootTartVm({ kind: 'tart', image: SEQUOIA }, SEQUOIA, 'reeval-r-1', signal, on),
          (error: Error) => error instanceof TartBusyError,
        )
      })
    } finally {
      release()
    }
  })

  test('a host that stays busy fails the attempt once its wait is up', async () => {
    const release = await holdLoopback()
    try {
      const fake = fakeTartHosts({ full: { images: [SEQUOIA], limit: 0 } })
      await withEnv(fake.env, async () => {
        const options = { signal: AbortSignal.timeout(20_000), runId: 'wait' }
        await assert.rejects(
          bootOnHost(onHosts(['full']), SEQUOIA, 'reeval-wait-000001', options, { waitMs: 0 }),
          (error: Error) =>
            error instanceof InfraError &&
            !(error instanceof TartBusyError) &&
            /Every tart\(\) host was at its VM limit/.test(error.message),
        )
      })
    } finally {
      release()
    }
  })

  test('two attempts after the one slot of a vms: 1 host take it one at a time', async () => {
    const release = await holdLoopback()
    try {
      const fake = fakeTartHosts({ one: { images: [SEQUOIA] } })
      await withEnv(fake.env, async () => {
        const abort = new AbortController()
        const options = { signal: abort.signal, runId: 'race' }
        const boots = ['00000a', '00000b'].map((id) =>
          bootOnHost(onHosts([{ host: 'one', vms: 1 }]), SEQUOIA, `reeval-race-${id}`, options),
        )
        try {
          await Promise.race(boots)
          await sleep(1500)
          assert.equal(fake.vms('one').length, 1, 'the other waits for the slot')
        } finally {
          abort.abort(new Error('done'))
          const settled = await Promise.allSettled(boots)
          for (const s of settled) if (s.status === 'fulfilled') await s.value.halt()
          assert.deepEqual(settled.map((s) => s.status).sort(), ['fulfilled', 'rejected'])
        }
      })
    } finally {
      release()
    }
  })

  test('a clone canceled on a host is deleted there once it finishes', async () => {
    const fake = fakeTartHosts({ slow: { images: [SEQUOIA], cloneSeconds: 2 } })
    await withEnv(fake.env, async () => {
      const abort = new AbortController()
      const on = hostTarget(parsed('slow'))
      const vm = 'reeval-cancel-000001'
      const booting = bootTartVm({ kind: 'tart', image: SEQUOIA }, SEQUOIA, vm, abort.signal, on)
      while (!fake.hostLog('slow').some((l) => l.startsWith('clone '))) await sleep(50)
      abort.abort(new Error('canceled'))
      await assert.rejects(booting, /canceled/)
      // The clone ends 2s in; its VM is gone within a second of that.
      await sleep(2500)
      for (let i = 0; i < 40 && fake.vms('slow').length; i++) await sleep(100)
      assert.deepEqual(fake.vms('slow'), [])
    })
  })

  test('--resume deletes what the stopped run left on every host', async () => {
    const fake = fakeTartHosts({ a: { images: [SEQUOIA] }, b: { images: [SEQUOIA] } })
    const left = `${vmPrefix(SEEDED_RUN_ID)}dead00`
    mkdirSync(join(fake.dir, 'hosts', 'b', 'vms', left), { recursive: true })
    const p = await project('tart-hosts-resume', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
export default defineConfig({ harnesses: fakeHarness() })
`,
      'evals/r.eval.ts': `import { evaluate } from 'reeval'
import { tart } from 'reeval/sandbox'
evaluate('e', {
  sandbox: tart({ image: '${SEQUOIA}', hosts: ['a', 'b'] }),
  egress: 'allow-all',
}, async () => {})
`,
    })
    writeStoppedStaging(p.dir, SEEDED_RUN_ID, [
      { file: 'evals/r.eval.ts', name: 'e', cell: 'fake/-/tart:macos-sequoia-base:15.6' },
    ])
    const r = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID], { env: fake.env })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(fake.vms('b'), [])
  })
})

describe('preparing the image on each host', {
  skip: !posix && 'the fake ssh is a bash script',
}, () => {
  const ctx = (lines: string[]) => ({
    root: '',
    signal: new AbortController().signal,
    log: (line: string) => lines.push(line),
    retry: <T>(step: () => Promise<T>) => step(),
  })

  test('a host its bake fails on is skipped; the target fails only when every one is', async () => {
    const release = await holdLoopback()
    try {
      const fake = fakeTartHosts({
        broken: { images: [SEQUOIA], cloneFails: 'disk full' },
        fine: { images: [SEQUOIA] },
      })
      await withEnv(fake.env, async () => {
        const harness = { kind: 'fake', bootstrap: 'true' } as const
        const lines: string[] = []
        const provider = tartProvider()
        const sandbox = { kind: 'tart', image: SEQUOIA, hosts: ['broken', 'fine'] } as const
        await provider.checkTargets?.([sandbox], ctx(lines))
        const handle = await provider.prepare(sandbox, harness, ctx(lines))
        assert.deepEqual(
          preparedHosts(handle)?.map((h) => h.host),
          ['fine'],
        )
        assert.ok(
          lines.some((l) => /^tart\(.*\) skipped broken: .*disk full/.test(l)),
          lines.join('\n'),
        )
        const alone = { kind: 'tart', image: SEQUOIA, hosts: ['broken'] } as const
        await provider.checkTargets?.([alone], ctx([]))
        await assert.rejects(provider.prepare(alone, harness, ctx([])), /disk full/)
      })
    } finally {
      release()
    }
  })

  test('refuses an image that is a different one on each host', async () => {
    const fake = fakeTartHosts({ a: { images: [SEQUOIA] }, b: { images: [SEQUOIA] } })
    // b's tag points at another pull of the image.
    const repo = join(
      fake.dir,
      'hosts',
      'b',
      'cache',
      'OCIs',
      'ghcr.io/cirruslabs/macos-sequoia-base',
    )
    const other = join(repo, `sha256:${'0'.repeat(64)}`)
    mkdirSync(other)
    rmSync(join(repo, '15.6'))
    symlinkSync(other, join(repo, '15.6'))
    assert.ok(existsSync(join(repo, '15.6')))
    await withEnv(fake.env, async () => {
      const provider = tartProvider()
      const sandbox = { kind: 'tart', image: SEQUOIA, hosts: ['a', 'b'] } as const
      await provider.checkTargets?.([sandbox], ctx([]))
      await assert.rejects(
        provider.prepare(sandbox, { kind: 'fake' }, ctx([])),
        /is a different image on each host[\s\S]*a: sha256:[0-9a-f]{64}\n {2}b: sha256:0{64}/,
      )
    })
  })
})
