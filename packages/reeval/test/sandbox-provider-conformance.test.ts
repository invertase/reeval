// The machine provider conformance suite: what every provider in MACHINE_PROVIDERS promises an
// attempt, checked through its kind's `create` on the provider's fake backend. Its session runs
// commands, files and reeval's own commands as the OS profile says; an aborted command dies in the
// machine with everything it started, however it detached; a secret in a command's variables
// reaches no command line; the run's machines are gone after `destroy`, `cleanupRun` or an abort
// mid-boot; and each capability it claims holds in the machine.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseProbe, probeScript } from '../src/attempt/serve.ts'
import { runPrefix } from '../src/sandbox/boat.ts'
import { runLabels } from '../src/sandbox/daytona.ts'
import type { SandboxOptions } from '../src/sandbox/index.ts'
import { SANDBOX_KINDS } from '../src/sandbox/kinds.ts'
import type { MachineDescriptor, MachineProvider } from '../src/sandbox/machine.ts'
import { MACHINE_PROVIDERS } from '../src/sandbox/machines.ts'
import { vmPrefix } from '../src/sandbox/tart.ts'
import { hasNetworkSession, type Sandbox } from '../src/sandbox/types.ts'
import { boat } from '../src/sandbox-boat.ts'
import { daytona } from '../src/sandbox-daytona.ts'
import { type FakeBoat, fakeBoat } from './support/boat.ts'
import { type FakeDaytona, fakeDaytona } from './support/daytona.ts'
import { fakeTart, holdLoopback } from './support/fake-tart.ts'
import { buildSshVmImage, SSH_VM_IMAGE, SSH_VM_LABEL, startSshVm } from './support/ssh-vm.ts'

type MachineKind = (typeof MACHINE_PROVIDERS)[number]['kind']

/** A provider's fake backend: what the suite creates machines on, and how it sees them. */
type Backend = {
  skip: string | false
  start(): Promise<void>
  stop(): Promise<void>
  descriptor(): MachineDescriptor
  /** The run's machines the backend still has. */
  machines(runId: string): string[]
  /** Whether the run has asked for a machine yet. */
  asked(runId: string): boolean
  /** Makes each boot take seconds, until the returned undo. */
  slowBoot(): () => void
  /** Runs a root shell script in the named machine, behind reeval's back, and returns its output. */
  inMachine?(name: string, script: string): string
}

const requireDocker = process.env.REEVAL_TEST_REQUIRE_DOCKER === '1'
const sshVmReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', SSH_VM_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let tartDir = ''
let releaseLoopback = () => {}
const savedTartEnv: Record<string, string | undefined> = {}
let boatApi: FakeBoat | undefined
const savedBoatEnv = { url: process.env.BOAT_BASE_URL, key: process.env.BOAT_API_KEY }
let daytonaApi: FakeDaytona | undefined
const savedDaytonaEnv = { url: process.env.DAYTONA_API_URL, key: process.env.DAYTONA_API_KEY }
const sshVmSkip =
  !requireDocker &&
  !sshVmReady &&
  `needs Docker and ${SSH_VM_IMAGE} (REEVAL_TEST_REQUIRE_DOCKER=1 builds it)`
/** Runs a root shell script in the fake SSH VM named `name`. */
const inSshVm = (name: string, script: string) => {
  const container = execFileSync('docker', [
    'ps',
    '-q',
    '--filter',
    `label=${SSH_VM_LABEL}=${name}`,
  ])
    .toString()
    .trim()
  return execFileSync('docker', ['exec', container, 'sh', '-c', script]).toString()
}

const BACKENDS: Record<MachineKind, Backend> = {
  tart: {
    skip: process.platform === 'win32' && 'the fake tart is a bash script',
    async start() {
      const fake = fakeTart()
      tartDir = fake.dir
      for (const name of Object.keys(fake.env)) savedTartEnv[name] = process.env[name]
      Object.assign(process.env, fake.env)
      releaseLoopback = await holdLoopback()
    },
    // Its `ssh` is first on PATH, so another provider's machines need PATH back.
    async stop() {
      releaseLoopback()
      for (const [name, value] of Object.entries(savedTartEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
    descriptor: () => ({ kind: 'tart', image: 'ghcr.io/cirruslabs/macos-sequoia-base:latest' }),
    machines: (runId) =>
      readdirSync(join(tartDir, 'vms')).filter((name) => name.startsWith(vmPrefix(runId))),
    asked: (runId) =>
      readFileSync(join(tartDir, 'log'), 'utf8')
        .split('\n')
        .some((line) => line.startsWith('clone ') && line.includes(` ${vmPrefix(runId)}`)),
    slowBoot() {
      writeFileSync(join(tartDir, 'clone-seconds'), '10')
      return () => rmSync(join(tartDir, 'clone-seconds'), { force: true })
    },
  },
  boat: {
    skip: sshVmSkip,
    async start() {
      buildSshVmImage()
      boatApi = await fakeBoat(startSshVm)
      process.env.BOAT_BASE_URL = boatApi.url
      process.env.BOAT_API_KEY = boatApi.key
    },
    async stop() {
      await boatApi?.close()
      for (const [name, value] of [
        ['BOAT_BASE_URL', savedBoatEnv.url],
        ['BOAT_API_KEY', savedBoatEnv.key],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
    descriptor: () => boat(),
    machines: (runId) =>
      (boatApi?.live() ?? []).filter((name) => name.startsWith(runPrefix(boat(), runId))),
    asked: (runId) => BACKENDS.boat.machines(runId).length > 0,
    // A container's sshd takes seconds to answer.
    slowBoot: () => () => {},
    inMachine: inSshVm,
  },
  daytona: {
    skip: sshVmSkip,
    async start() {
      buildSshVmImage()
      daytonaApi = await fakeDaytona(startSshVm)
      process.env.DAYTONA_API_URL = daytonaApi.url
      process.env.DAYTONA_API_KEY = daytonaApi.key
    },
    async stop() {
      await daytonaApi?.close()
      for (const [name, value] of [
        ['DAYTONA_API_URL', savedDaytonaEnv.url],
        ['DAYTONA_API_KEY', savedDaytonaEnv.key],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
    descriptor: () => daytona(),
    machines(runId) {
      const labels = runLabels(daytona(), runId)
      const mine = new Set(
        (daytonaApi?.created() ?? [])
          .filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
          .map((s) => s.name),
      )
      return (daytonaApi?.live() ?? []).filter((name) => mine.has(name))
    },
    asked: (runId) =>
      (daytonaApi?.created() ?? []).some(
        (s) => s.labels['reeval-run'] === runLabels(daytona(), runId)['reeval-run'],
      ),
    slowBoot: () => () => {},
    inMachine: inSshVm,
  },
}

const options = (runId: string, o: Partial<SandboxOptions> = {}): SandboxOptions => ({
  runId,
  timeoutMs: 120_000,
  signal: new AbortController().signal,
  env: {},
  egress: { policy: 'allow-all', auto: [] },
  ...o,
})

const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const deadline = Date.now() + ms; !(await check()); ) {
    assert.ok(Date.now() < deadline, what)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** How a promise settled within `ms`: an aborted command must return, not hang. */
const settled = (p: Promise<unknown>, ms = 20_000) =>
  Promise.race([
    p.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>((r) => setTimeout(() => r('still waiting'), ms)),
  ])

/**
 * Every process's command line in the machine, as reeval's own commands see them. A `ps` that
 * failed would read as no survivors, so it must have listed itself.
 */
const machineArgs = async (box: Sandbox) => {
  const ps = await box.execOwn('ps -A -ww -o args=')
  const args = ps.stdout.split('\n').map((line) => line.trim())
  assert.equal(ps.exitCode, 0, `ps in the machine failed: ${ps.stderr}`)
  assert.ok(args.includes('ps -A -ww -o args='), `ps in the machine listed nothing: ${ps.stdout}`)
  return args
}

/** How many processes in the machine run exactly `sleep <n>`. */
const sleeping = async (box: Sandbox, n: number) =>
  (await machineArgs(box)).filter((args) => args === `sleep ${n}`).length

const token = () => 200_000 + Math.floor(Math.random() * 700_000)

/**
 * Kills what a failed check left running as `sleep <n>`: a survivor holds the command's output
 * open, which would keep the file from ending.
 */
const reap = (box: Sandbox, n: number) =>
  box.execOwn(`pkill -9 -x -f 'sleep ${n}'; true`).catch(() => {})

/**
 * The ways a command's processes outlive it: each an agent's command line, the processes it
 * leaves running as `sleep <n>`, and the OSes it runs on.
 */
const DETACHED: Array<{
  name: string
  command: (n: number) => string
  count: number
  os?: 'linux'
}> = [
  { name: 'the command itself', command: (n) => `sleep ${n}`, count: 1 },
  { name: 'a background child', command: (n) => `sleep ${n} & wait`, count: 1 },
  {
    name: 'a grandchild orphaned by a double fork',
    command: (n) => `(sleep ${n} &); sleep ${n}`,
    count: 2,
  },
  {
    name: 'a child that clears its environment',
    command: (n) => `env -i sleep ${n} & sleep ${n}`,
    count: 2,
  },
  {
    name: 'a child in a session of its own',
    command: (n) => `setsid sleep ${n} & sleep ${n}`,
    count: 2,
    os: 'linux',
  },
]

for (const machine of MACHINE_PROVIDERS as readonly MachineProvider<MachineDescriptor>[]) {
  const backend = BACKENDS[machine.kind]
  const kind = SANDBOX_KINDS[machine.kind]
  const runId = `conform-${machine.kind}-${process.pid}`
  const create = (id = runId, o: Partial<SandboxOptions> = {}) =>
    kind.create(backend.descriptor() as never, options(id, o))

  describe(`machine provider: ${machine.kind}`, { skip: backend.skip, timeout: 300_000 }, () => {
    let box: Sandbox
    before(async () => {
      await backend.start()
      box = await create(runId, { env: { REEVAL_CONFORM_VAR: 'from-the-sandbox' } })
    })
    after(async () => {
      try {
        await box?.destroy()
      } finally {
        await backend.stop()
      }
    })

    describe('session', () => {
      test('exec: exit codes, stderr, the workspace, and per-command env over the sandbox env', async () => {
        assert.deepEqual(await box.exec('echo out; echo err >&2; exit 7'), {
          exitCode: 7,
          stdout: 'out\n',
          stderr: 'err\n',
        })
        assert.equal((await box.exec('pwd')).stdout.trim(), box.workdir)
        await box.exec('mkdir -p sub')
        assert.equal((await box.exec('pwd', { cwd: 'sub' })).stdout.trim(), `${box.workdir}/sub`)
        assert.equal((await box.exec('printf %s "$REEVAL_CONFORM_VAR"')).stdout, 'from-the-sandbox')
        const over = await box.exec('printf %s "$REEVAL_CONFORM_VAR"', {
          env: { REEVAL_CONFORM_VAR: 'from-the-command' },
        })
        assert.equal(over.stdout, 'from-the-command')
      })

      test('files: every byte value, nested directories, and ~/ in the home', async () => {
        assert.ok(hasNetworkSession(box), 'a machine gives the harness a session')
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
        await box.writeFile('deep/er/bytes.bin', bytes)
        const back = await box.network.readBinaryFile({ path: `${box.workdir}/deep/er/bytes.bin` })
        assert.deepEqual(back && Buffer.from(back), Buffer.from(bytes))
        assert.equal((await box.exec('wc -c < deep/er/bytes.bin')).stdout.trim(), '256')
        await box.writeFile('~/.config/conform/h.txt', 'home\n')
        assert.equal((await box.exec('cat ~/.config/conform/h.txt')).stdout, 'home\n')
        assert.equal(await box.readFile('no/such/file'), null)
      })

      test("reeval's own commands write its state directory, which the agent reads only on darwin", async () => {
        await box.execOwn(`printf own > ${box.stateDir}/conform-own`)
        const agent = await box.exec(`cat ${box.stateDir}/conform-own`)
        if (machine.os === 'darwin') {
          assert.equal(agent.stdout, 'own', "darwin's agent is reeval's user")
        } else {
          assert.notEqual(agent.exitCode, 0, `the agent read ${box.stateDir}`)
        }
      })

      test("a secret in a command's variables reaches no command line, on the host or in the machine", async () => {
        const secret = `conform-secret-${randomBytes(8).toString('hex')}`
        const n = token()
        const stop = new AbortController()
        const running = box.exec(`sleep ${n}`, {
          env: { REEVAL_CONFORM_SECRET: secret },
          signal: stop.signal,
        })
        running.catch(() => {})
        try {
          await until('the command started', async () => (await sleeping(box, n)) > 0)
          const host = execFileSync('ps', ['-A', '-ww', '-o', 'args=']).toString()
          assert.ok(!host.includes(secret), 'the secret is on a host command line')
          const inside = await machineArgs(box)
          assert.ok(
            !inside.some((args) => args.includes(secret)),
            'the secret is on a machine command line',
          )
        } finally {
          stop.abort()
          await settled(running)
        }
      })
    })

    describe('an aborted command dies in the machine', () => {
      for (const shape of DETACHED) {
        test(`exec: ${shape.name}`, {
          skip: !!shape.os && shape.os !== machine.os && `${shape.os} only`,
        }, async () => {
          const n = token()
          const stop = new AbortController()
          const running = box.exec(shape.command(n), { signal: stop.signal })
          running.catch(() => {})
          try {
            await until('the command started', async () => (await sleeping(box, n)) >= shape.count)
            stop.abort(new Error('canceled'))
            await until(
              `a process the aborted command started still runs in the machine: sleep ${n}`,
              async () => (await sleeping(box, n)) === 0,
            )
            assert.equal(await settled(running), 'rejected', 'the aborted command returned')
          } finally {
            await reap(box, n)
          }
        })
      }

      test("an abort leaves the machine's other commands running, the agent's and reeval's own", async () => {
        const [n, agent, own] = [token(), token(), token()]
        const stop = new AbortController()
        const keep = new AbortController()
        const running = box.exec(`sleep ${n}`, { signal: stop.signal })
        const others = [
          box.exec(`sleep ${agent}`, { signal: keep.signal }),
          box.execOwn(`sleep ${own}`, { signal: keep.signal }),
        ]
        for (const p of [running, ...others]) p.catch(() => {})
        try {
          await until(
            'the commands started',
            async () =>
              (await sleeping(box, n)) === 1 &&
              (await sleeping(box, agent)) === 1 &&
              (await sleeping(box, own)) === 1,
          )
          stop.abort(new Error('canceled'))
          await until('the aborted command died', async () => (await sleeping(box, n)) === 0)
          assert.equal(await settled(running), 'rejected', 'the aborted command returned')
          assert.equal(
            await sleeping(box, agent),
            1,
            "the abort killed another of the agent's commands",
          )
          assert.equal(await sleeping(box, own), 1, "the abort killed one of reeval's own commands")
        } finally {
          keep.abort()
          await Promise.all(others.map((p) => settled(p)))
          for (const k of [n, agent, own]) await reap(box, k)
        }
      })

      test("the harness session's spawn: an abort, and kill(), each stop its whole tree", async () => {
        assert.ok(hasNetworkSession(box))
        for (const how of ['abort', 'kill'] as const) {
          const n = token()
          const stop = new AbortController()
          const child = await box.network.spawn({
            command: `(sleep ${n} &); sleep ${n} & wait`,
            abortSignal: stop.signal,
          })
          try {
            await until(`${how}: the command started`, async () => (await sleeping(box, n)) >= 2)
            if (how === 'abort') stop.abort()
            else await child.kill()
            await until(
              `${how}: a process it started still runs in the machine: sleep ${n}`,
              async () => (await sleeping(box, n)) === 0,
            )
            assert.notEqual(await settled(child.wait()), 'still waiting', `${how}: it returned`)
          } finally {
            await reap(box, n)
          }
        }
      })
    })

    describe('lifecycle', () => {
      test('destroy removes the machine, and a second destroy is a no-op', async () => {
        const id = `${runId}-destroy`
        const own = await create(id)
        assert.equal(backend.machines(id).length, 1)
        await own.destroy()
        await own.destroy()
        await until('the machine is gone', () => backend.machines(id).length === 0)
      })

      test('cleanupRun removes a machine its attempt never destroyed', async () => {
        const id = `${runId}-left`
        const left = await create(id)
        try {
          assert.equal(backend.machines(id).length, 1)
          await kind.cleanupRun?.(id, [backend.descriptor() as never])
          await until('cleanupRun left a machine', () => backend.machines(id).length === 0)
        } finally {
          await left.destroy()
        }
      })

      test('an attempt canceled while its machine boots leaves no machine', async () => {
        const id = `${runId}-canceled`
        const attempt = new AbortController()
        const undo = backend.slowBoot()
        const booting = create(id, { signal: attempt.signal })
        booting.catch(() => {})
        try {
          await until('the machine was asked for', () => backend.asked(id), 60_000)
        } finally {
          undo()
        }
        attempt.abort(new Error('canceled'))
        const outcome = await booting.then(
          async (late) => {
            await late.destroy()
            return 'created'
          },
          () => 'rejected',
        )
        assert.equal(outcome, 'rejected', 'the canceled attempt still got its sandbox')
        await until('the canceled machine is gone', () => backend.machines(id).length === 0, 60_000)
      })
    })

    describe('pooled machines', { skip: !machine.pool && 'no pool' }, () => {
      const pooled = (o: object) => ({ ...backend.descriptor(), ...o }) as never
      test('reuse: the next attempt gets the machine with nothing the last one left', async () => {
        const id = `${runId}-reuse`
        const harness = { kind: 'fake', bootstrap: 'echo "$$-$RANDOM" > install' } as const
        const first = await kind.create(pooled({ reuse: true }), options(id, { harness }))
        const install = (await first.exec('cat ~/install')).stdout
        await first.exec(
          'touch ~/left /tmp/left-$(id -un); n=555111; (setsid sleep $n >/dev/null 2>&1 &)',
        )
        await first.destroy()
        const second = await kind.create(pooled({ reuse: true }), options(id, { harness }))
        try {
          assert.equal(backend.machines(id).length, 1, 'the second attempt reused the machine')
          const left = await second.exec(
            'ls ~/left /tmp/left-$(id -un) 2>/dev/null; pgrep -u "$(id -un)" -x -f "sleep 555111"; true',
          )
          assert.equal(left.stdout, '', 'the reset left nothing behind')
          const again = (await second.exec('cat ~/install')).stdout
          assert.equal(again, install, "the home is the first attempt's install, not run again")
        } finally {
          await second.destroy()
        }
        await until('the idle machine is gone', () => backend.machines(id).length === 0, 30_000)
      })

      test('attemptsPerMachine: slots share a machine as users that see none of each other', async () => {
        const id = `${runId}-shared`
        const [a, b] = await Promise.all([
          kind.create(pooled({ attemptsPerMachine: 2 }), options(id)),
          kind.create(pooled({ attemptsPerMachine: 2 }), options(id)),
        ])
        try {
          assert.equal(backend.machines(id).length, 1, 'both slots are on one machine')
          const who = async (box: Sandbox) => (await box.exec('id -un; echo ~')).stdout
          assert.notEqual(await who(a), await who(b))
          assert.notEqual(a.workdir, b.workdir)
          await a.writeFile('secret.txt', 'slot a')
          await a.exec('echo slot a > ~/secret.txt')
          const peek = await b.exec(
            `cat ${a.workdir}/secret.txt 2>/dev/null; cat ~/secret.txt /home/*/secret.txt 2>/dev/null; true`,
          )
          assert.equal(peek.stdout, '', "one slot reads neither the other's workspace nor its home")
          if (kind.capabilities.listeners === 'proc') {
            await a.exec(
              `(setsid node -e "require('net').createServer().listen(45111, '127.0.0.1')" >/dev/null 2>&1 &)`,
            )
            await until(
              'slot a listens',
              async () => {
                const own = parseProbe((await a.exec(probeScript())).stdout, { byUser: true })
                return own.proc && own.listeners.some((l) => l.port === 45111)
              },
              10_000,
            )
            let seen = parseProbe('')
            await until(
              "slot b sees slot a's port",
              async () => {
                seen = parseProbe((await b.exec(probeScript())).stdout, { byUser: true })
                return seen.proc && (seen.others ?? []).includes(45111)
              },
              10_000,
            )
            assert.ok(
              seen.proc && !seen.listeners.some((l) => l.port === 45111),
              "c.serve in one slot never takes the other's listener",
            )
          }
        } finally {
          await Promise.all([a.destroy(), b.destroy()])
        }
        await until('the shared machine is gone', () => backend.machines(id).length === 0, 30_000)
      })

      test('attemptsPerMachine: one slot installs the harness, and each other slot gets its own copy', async () => {
        const id = `${runId}-shared-install`
        const harness = {
          kind: 'fake',
          bootstrap: `sleep 2; echo "$(id -un) $HOME" > installed; ln -s "$HOME/installed" link; printf '\\177ELF\\0%s' "$HOME/installed" > binary`,
        } as const
        const boxes = await Promise.all(
          [0, 1, 2].map(() =>
            kind.create(pooled({ attemptsPerMachine: 3 }), options(id, { harness })),
          ),
        )
        try {
          assert.equal(backend.machines(id).length, 1, 'the three slots are on one machine')
          const saw = await Promise.all(
            boxes.map(async (box) =>
              (
                await box.exec(
                  'echo "$(id -un) $HOME"; cat ~/installed; stat -c %U ~/installed; readlink ~/link; stat -c %a ~; stat -c %U "$(tail -c +6 ~/binary)"',
                )
              ).stdout
                .trim()
                .split('\n'),
            ),
          )
          const installers = new Set(saw.map(([, installed]) => installed?.split(' ')[0]))
          assert.equal(installers.size, 1, `the bootstrap ran in one slot: ${[...installers]}`)
          for (const [self = '', installed = '', owner, link, mode, binary] of saw) {
            const [user, home] = self.split(' ')
            assert.equal(installed.split(' ')[1], home, 'the copy names its own home')
            assert.equal(owner, user, 'the copy is its own user')
            assert.equal(link, `${home}/installed`, 'a link into the home points at its own')
            assert.equal(mode, '700', 'the home stays closed to the other slots')
            assert.equal(binary, user, "a path in a binary file leads into the slot's own home")
          }
        } finally {
          await Promise.all(boxes.map((box) => box.destroy()))
        }
        await until('the shared machine is gone', () => backend.machines(id).length === 0, 30_000)
      })

      test("attemptsPerMachine: a slot whose copy of the machine's install won't unpack installs its own", {
        skip: !backend.inMachine && 'no shell in the fake machine',
      }, async () => {
        const id = `${runId}-shared-bad-copy`
        const harness = { kind: 'fake', bootstrap: 'echo "$(id -un)" > installed' } as const
        const descriptor = pooled({ attemptsPerMachine: 2 })
        const first = await kind.create(descriptor, options(id, { harness }))
        try {
          const [machineName = ''] = backend.machines(id)
          backend.inMachine?.(
            machineName,
            'for f in /var/lib/reeval-pool/*.tar; do echo bad > "$f"; done',
          )
          const second = await kind.create(descriptor, options(id, { harness }))
          try {
            const [self, installed] = (await second.exec('id -un; cat ~/installed')).stdout
              .trim()
              .split('\n')
            assert.equal(installed, self, 'the slot installed the harness itself')
          } finally {
            await second.destroy()
          }
        } finally {
          await first.destroy()
        }
        await until('the shared machine is gone', () => backend.machines(id).length === 0, 30_000)
      })

      test('attemptsPerMachine: when the installing slot dies, a waiting slot installs at once', {
        skip: !backend.inMachine && 'no shell in the fake machine',
      }, async () => {
        const id = `${runId}-shared-dead-installer`
        // The first slot to install hangs; any other installs straight away.
        const harness = {
          kind: 'fake',
          bootstrap:
            'mkdir /tmp/reeval-first 2>/dev/null && sleep 600; echo "$(id -un)" > installed',
        } as const
        const descriptor = pooled({ attemptsPerMachine: 2 })
        const stuck = new AbortController()
        const boxes = [0, 1].map(() =>
          kind.create(descriptor, options(id, { harness, signal: stuck.signal })),
        )
        const settledBoxes = Promise.allSettled(boxes)
        try {
          await until(
            'a slot is installing',
            () => {
              const [machineName] = backend.machines(id)
              if (!machineName) return false
              try {
                return !!backend.inMachine?.(machineName, 'pgrep -x -f "sleep 600" || true').trim()
              } catch {
                return false
              }
            },
            60_000,
          )
          const [machineName = ''] = backend.machines(id)
          // What holds the install's lock dies, as it would with the reeval that started it.
          backend.inMachine?.(machineName, 'pkill -KILL -x cat; true')
          const waiter = await Promise.race([
            Promise.any(boxes),
            new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000)),
          ])
          assert.ok(
            waiter,
            "the waiting slot was still waiting 20s after the installer's lock died",
          )
          const [self, installed] = (await waiter.exec('id -un; cat ~/installed')).stdout
            .trim()
            .split('\n')
          assert.equal(installed, self, 'the waiting slot installed the harness itself')
        } finally {
          stuck.abort(new Error('canceled'))
          for (const r of await settledBoxes) if (r.status === 'fulfilled') await r.value.destroy()
        }
        await until('the shared machine is gone', () => backend.machines(id).length === 0, 30_000)
      })

      test("attemptsPerMachine: one slot's kill leaves the other's command of the same number running", async () => {
        const id = `${runId}-shared-kill`
        const [a, b] = await Promise.all([
          kind.create(pooled({ attemptsPerMachine: 2 }), options(id)),
          kind.create(pooled({ attemptsPerMachine: 2 }), options(id)),
        ])
        const [na, nb] = [token(), token()]
        const stop = new AbortController()
        const keep = new AbortController()
        try {
          // Each slot's first command, so both carry the same exec number.
          const killed = a.exec(`sleep ${na}`, { signal: stop.signal })
          const kept = b.exec(`sleep ${nb}`, { signal: keep.signal })
          for (const p of [killed, kept]) p.catch(() => {})
          await until(
            'both started',
            async () => (await sleeping(b, na)) === 1 && (await sleeping(b, nb)) === 1,
          )
          stop.abort(new Error('canceled'))
          await until('the killed command died', async () => (await sleeping(b, na)) === 0)
          assert.equal(await sleeping(b, nb), 1, "the other slot's command was killed too")
          keep.abort()
          await settled(kept)
        } finally {
          for (const k of [na, nb]) await reap(b, k)
          await Promise.all([a.destroy(), b.destroy()])
        }
        await until('the shared machine is gone', () => backend.machines(id).length === 0, 30_000)
      })
    })

    describe('capabilities hold in the machine', () => {
      const caps = kind.capabilities
      test('processTable: a Linux /proc and bash, when claimed', {
        skip: !caps.processTable && 'not claimed',
      }, async () => {
        assert.equal((await box.exec('test -r /proc/self/environ && command -v bash')).exitCode, 0)
      })

      test(`listeners: ${caps.listeners}`, async () => {
        const probe =
          caps.listeners === 'proc'
            ? 'test -r /proc/net/tcp && test -r /proc/net/tcp6'
            : caps.listeners === 'lsof'
              ? 'command -v lsof'
              : `echo "no probe for ${caps.listeners}"; exit 1`
        assert.equal((await box.execOwn(probe)).exitCode, 0, probe)
      })

      test('egress: no policy it says it enforces goes unprobed', () => {
        assert.equal(
          caps.egress.enforce,
          'none',
          'a provider that enforces egress needs a probe here that a direct connection is refused',
        )
        assert.equal(caps.egress.switches, false)
      })
    })
  })
}
