// The sandbox kind registry: every kind answers for itself, and what planning and the attempt ask
// of a sandbox (egress, brokering, a harness session, the platform) comes from its capabilities.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setupAllowance } from '../src/attempt/index.ts'
import { neededCredentials, resolveConfig } from '../src/config.ts'
import { SANDBOX_EGRESS } from '../src/egress.ts'
import { agentSandboxProblem } from '../src/harness/agent.ts'
import { AGENTS } from '../src/harness/agents.ts'
import { fakeHarness } from '../src/harness.ts'
import type { PlannedAttempt } from '../src/options.ts'
import { planEval } from '../src/plan-eval.ts'
import {
  capabilitiesOf,
  isSandboxKind,
  maxConcurrentProblem,
  providerLimit,
  SANDBOX_KINDS,
  sandboxHelpers,
  sandboxKind,
  suggestedSandbox,
} from '../src/sandbox/kinds.ts'
import { kindOf, type MachineProvider } from '../src/sandbox/machine.ts'
import { MACHINE_PROVIDERS } from '../src/sandbox/machines.ts'
import { classifyTart, createProviders, tartHostProblem } from '../src/sandbox/providers.ts'
import { docker, fakeSandbox, podman, tart } from '../src/sandbox.ts'
import { boat } from '../src/sandbox-boat.ts'
import type {
  BoatSandboxDescriptor,
  ResolvedConfig,
  SandboxDescriptor,
  TartSandboxDescriptor,
} from '../src/types.ts'

const IMAGE = 'ghcr.io/cirruslabs/macos-sequoia-base:latest'

describe('sandbox kinds', () => {
  test('every kind is in the table, and nothing else is a kind', () => {
    assert.deepEqual(Object.keys(SANDBOX_KINDS).sort(), [
      'boat',
      'daytona',
      'docker',
      'fake',
      'hosted',
      'tart',
    ])
    assert.ok(isSandboxKind('docker'))
    assert.ok(isSandboxKind('tart'))
    assert.ok(!isSandboxKind('vm'))
    assert.ok(!isSandboxKind('toString'))
    assert.ok(!isSandboxKind(undefined))
  })

  test('each kind names its helpers, and messages list them all', () => {
    assert.equal(
      sandboxHelpers(),
      'docker(), podman(), fakeSandbox(), tart(), boat(), daytona() or hosted()',
    )
    assert.equal(
      suggestedSandbox((c) => c.pluginBuilds),
      'docker()',
    )
    assert.equal(
      suggestedSandbox(() => false),
      '',
    )
  })

  test('every provider a kind names has a prepare provider', () => {
    const providers = createProviders()
    for (const sandbox of [docker(), podman(), fakeSandbox(), tart({ image: IMAGE }), boat()]) {
      const name = sandboxKind(sandbox).provider(sandbox)
      assert.equal(providers[name]?.kind, name)
    }
  })

  test('egress capabilities come from the kinds', () => {
    for (const [kind, entry] of Object.entries(SANDBOX_KINDS)) {
      assert.deepEqual(
        SANDBOX_EGRESS[kind as keyof typeof SANDBOX_KINDS],
        entry.capabilities.egress,
      )
    }
  })

  test('Docker is an isolated Linux machine that brokers; the fake sandbox is the host', () => {
    assert.deepEqual(capabilitiesOf(docker()), {
      platform: 'linux',
      egress: { enforce: 'allowlist', record: true, switches: true },
      brokers: true,
      harnessSession: true,
      isolated: true,
      processTable: true,
      listeners: 'proc',
      images: true,
      preflight: true,
      pluginBuilds: true,
    })
    assert.deepEqual(capabilitiesOf(fakeSandbox()), {
      platform: process.platform,
      egress: { enforce: 'none', record: false, switches: true },
      brokers: false,
      harnessSession: false,
      isolated: false,
      processTable: false,
      listeners: 'host',
      images: false,
      preflight: false,
      pluginBuilds: false,
    })
  })

  test('Tart is an isolated macOS VM that brokers, preflight pulls and bakes, and runs every harness', () => {
    assert.deepEqual(capabilitiesOf(tart({ image: IMAGE })), {
      platform: 'darwin',
      egress: { enforce: 'none', record: true, switches: false },
      brokers: true,
      harnessSession: true,
      isolated: true,
      processTable: false,
      listeners: 'lsof',
      images: false,
      preflight: true,
      pluginBuilds: false,
    })
    assert.equal(
      sandboxKind(tart({ image: IMAGE })).id(tart({ image: IMAGE })),
      'tart:macos-sequoia-base:latest',
    )
    assert.equal(sandboxKind(tart({ image: 'mine' })).provider(tart({ image: 'mine' })), 'tart')
  })

  test("Boat is an isolated Linux VM that brokers, with no image and egress it can't hold", () => {
    assert.deepEqual(capabilitiesOf(boat()), {
      platform: 'linux',
      egress: { enforce: 'none', record: true, switches: false },
      brokers: true,
      harnessSession: true,
      isolated: true,
      processTable: true,
      listeners: 'proc',
      images: false,
      preflight: true,
      pluginBuilds: false,
    })
  })

  test("a sandbox that boots a VM or builds an image at start widens the attempt's limit", () => {
    const allowance = (sandbox: SandboxDescriptor) =>
      setupAllowance({
        sandbox,
        harness: fakeHarness(),
        environment: { layers: [] },
      } as unknown as PlannedAttempt)
    const plain = allowance(docker())
    const booting = [boat(), boat({ type: 'large' }), tart({ image: IMAGE }), docker({ from: 'x' })]
    for (const sandbox of booting)
      assert.ok(allowance(sandbox) > plain, sandboxKind(sandbox).id(sandbox))
    assert.deepEqual(new Set(booting.map(allowance)).size, 1)
    assert.equal(allowance(fakeSandbox()), plain)
  })

  test('what a Docker sandbox widens is its own privileges; the fake one widens none', () => {
    assert.deepEqual(sandboxKind(docker()).privileges(docker({ root: true })), {
      root: true,
      capabilities: [],
    })
    assert.deepEqual(sandboxKind(docker()).privileges(docker({ capabilities: ['NET_RAW'] })), {
      root: false,
      capabilities: ['NET_RAW'],
    })
    assert.deepEqual(sandboxKind(fakeSandbox()).privileges(fakeSandbox()), {
      root: false,
      capabilities: [],
    })
  })
})

describe('which sandbox a real harness runs in', () => {
  test('one with a harness session that brokers, on a platform its bootstrap installs', () => {
    assert.equal(agentSandboxProblem(AGENTS.cursor, docker()), undefined)
    assert.equal(agentSandboxProblem(AGENTS.codex, podman()), undefined)
  })

  test('the fake sandbox names what it lacks and the sandbox that has it', () => {
    assert.equal(
      agentSandboxProblem(AGENTS.cursor, fakeSandbox()),
      "The Cursor harness can't run in the fake sandbox, which has no harness session and can't keep CURSOR_API_KEY out of it: set sandbox: docker() or tart() or boat() or daytona() or hosted() for this eval, or use fakeHarness() with fakeSandbox()",
    )
  })

  test('Boat runs every harness, each of whose bootstraps installs for Linux', () => {
    for (const kind of Object.keys(AGENTS) as (keyof typeof AGENTS)[]) {
      assert.equal(agentSandboxProblem(AGENTS[kind], boat()), undefined, kind)
    }
  })

  test('Tart runs every harness, each of whose bootstraps installs for macOS', () => {
    const mac = tart({ image: IMAGE })
    for (const kind of Object.keys(AGENTS) as (keyof typeof AGENTS)[]) {
      assert.equal(agentSandboxProblem(AGENTS[kind], mac), undefined, kind)
    }
  })

  test("the fake sandbox's platform is the host's, which it never names", () => {
    const aixOnly = { ...AGENTS.cursor, platforms: ['aix'] as const }
    assert.doesNotMatch(agentSandboxProblem(aixOnly, fakeSandbox()) ?? '', /runs /)
  })

  test('a platform no sandbox runs leaves only the fake harness', () => {
    const windowsOnly = { ...AGENTS.cursor, platforms: ['win32'] as const }
    assert.equal(
      agentSandboxProblem(windowsOnly, docker()),
      "The Cursor harness can't run in the docker sandbox, which runs linux, not win32: use fakeHarness() with fakeSandbox()",
    )
  })
})

describe('how many sandboxes run at once', () => {
  test('Tart runs two VMs at once unless maxConcurrent says fewer, and refuses more', () => {
    assert.equal(providerLimit(tart({ image: IMAGE })), 2)
    assert.equal(providerLimit(tart({ image: IMAGE, maxConcurrent: 1 })), 1)
    assert.equal(maxConcurrentProblem(tart({ image: IMAGE, maxConcurrent: 2 }), 'e'), undefined)
    assert.equal(
      maxConcurrentProblem({ kind: 'tart', image: IMAGE, maxConcurrent: 3 }, 'e'),
      'sandbox.maxConcurrent in e is 3, but tart() runs at most 2 at once: macOS runs two macOS VMs at a time',
    )
    assert.throws(() => tart({ image: IMAGE, maxConcurrent: 3 }), /at most 2 macOS VMs/)
  })

  test('with hosts, Tart runs as many VMs at once as the hosts take together', () => {
    const macs = tart({ image: IMAGE, hosts: ['mac-studio', { host: 'mac-mini', vms: 1 }] })
    assert.equal(providerLimit(macs), 3)
    assert.equal(providerLimit({ ...macs, maxConcurrent: 2 }), 2)
    assert.equal(maxConcurrentProblem({ ...macs, maxConcurrent: 3 }, 'e'), undefined)
    assert.match(maxConcurrentProblem({ ...macs, maxConcurrent: 4 }, 'e') ?? '', /is 4, but/)
  })

  test("each attempt's gate holds Tart to its limit, whatever the run's concurrency", () => {
    const plan = (sandbox: SandboxDescriptor) => {
      const config = resolveConfig(
        { harnesses: fakeHarness(), sandbox, egress: 'allow-all' },
        tmpdir(),
        'reeval.config.ts',
      )
      const { tests } = planEval(
        { name: 'e', mode: 'run', groups: [], options: {}, source: { body: '0'.repeat(64) } },
        { config, profile: null, tags: [], concurrency: 8, file: undefined, order: 0 },
      )
      return tests?.[0]?.gate.limits
    }
    assert.deepEqual(plan(tart({ image: IMAGE })), { attempts: 8, 'sandbox:tart': 2 })
    assert.deepEqual(plan(tart({ image: IMAGE, maxConcurrent: 1 })), {
      attempts: 8,
      'sandbox:tart': 1,
    })
    assert.deepEqual(plan(tart({ image: IMAGE, hosts: ['a', 'b', { host: 'c', vms: 1 }] })), {
      attempts: 8,
      'sandbox:tart': 5,
    })
    assert.deepEqual(plan(docker()), { attempts: 8 })
  })

  test('Docker and the fake sandbox have no limit of their own', () => {
    assert.equal(providerLimit(docker()), undefined)
    assert.equal(providerLimit(fakeSandbox()), undefined)
    assert.equal(providerLimit(docker({ maxConcurrent: 8 })), 8)
    assert.equal(maxConcurrentProblem(docker({ maxConcurrent: 64 }), 'e'), undefined)
  })
})

describe('the Tart provider', () => {
  test('runs on Apple Silicon Macs only', () => {
    assert.equal(tartHostProblem('darwin', 'arm64'), null)
    assert.match(tartHostProblem('darwin', 'x64') ?? '', /this machine is darwin-x64/)
    assert.match(tartHostProblem('linux', 'arm64') ?? '', /Apple Silicon.*or in docker\(\)/)
  })

  test('keys on the image, the user and the harness it bakes, and classes a full disk and a network error', () => {
    const provider = createProviders().tart
    const sandbox = tart({ image: 'a', cpus: 4 })
    assert.equal(provider?.key(sandbox, { kind: 'fake' }), '{"image":"a","user":null,"bake":null}')
    assert.equal(
      provider?.key(tart({ image: 'a', cpus: 8 }), { kind: 'fake' }),
      provider?.key(sandbox, { kind: 'fake' }),
    )
    assert.match(
      provider?.key(sandbox, { kind: 'pi' }) ?? '',
      /^\{"image":"a","user":null,"bake":"pi-\d+\.\d+\.\d+"\}$/,
    )
    assert.match(
      provider?.key(sandbox, { kind: 'fake', bootstrap: 'true' }) ?? '',
      /"bake":"fake-[0-9a-f]{8}"/,
    )
    assert.equal(classifyTart(new Error('No space left on device')).cause, 'enospc')
    assert.equal(classifyTart(new Error('connection reset by peer')).class, 'transient')
    assert.equal(classifyTart(new Error('image not found')).class, 'config')
  })
})

const tartVm = (o: Partial<TartSandboxDescriptor> = {}): TartSandboxDescriptor => ({
  kind: 'tart',
  image: 'ghcr.io/cirruslabs/macos-sequoia-base:latest',
  ...o,
})
const boatVm = (o: Partial<BoatSandboxDescriptor> = {}): BoatSandboxDescriptor => ({
  kind: 'boat',
  apiKey: { kind: 'secret', from: 'BOAT_API_KEY' },
  prefix: 'reeval-',
  ...o,
})

describe('machine providers', () => {
  test("a provider's free machines are the run's capacity, at least one", async () => {
    let free: number | null = 0
    const machine: MachineProvider<BoatSandboxDescriptor> = {
      ...MACHINE_PROVIDERS[1],
      capacity: async () => (free === null ? null : { machines: free }),
    }
    const kind = kindOf(machine)
    assert.deepEqual(await kind.capacity?.(boatVm()), { cpus: 1, memoryBytes: 1e9 })
    free = 3
    assert.deepEqual(await kind.capacity?.(boatVm()), { cpus: 3, memoryBytes: 3e9 })
    free = null
    assert.equal(await kind.capacity?.(boatVm()), null)
    assert.equal(SANDBOX_KINDS.tart.capacity, undefined)
  })

  test("cleanup is given Boat's accounts at the start, and other Macs once the plan names them", () => {
    assert.deepEqual(SANDBOX_KINDS.boat.cleanupScope?.(boatVm()), {
      key: JSON.stringify(boatVm()),
      atStart: true,
    })
    assert.equal(SANDBOX_KINDS.tart.cleanupScope?.(tartVm()), null)
    assert.deepEqual(SANDBOX_KINDS.tart.cleanupScope?.(tartVm({ hosts: ['mac-1'] })), {
      key: '["mac-1"]',
      atStart: false,
    })
    for (const kind of [SANDBOX_KINDS.docker, SANDBOX_KINDS.fake]) {
      assert.equal(kind.cleanupScope, undefined)
    }
  })

  test("a run needs boat()'s key, once, and no other sandbox's", () => {
    const config = { harness: [], judge: {}, env: {}, profiles: {} } as unknown as ResolvedConfig
    const lines = neededCredentials(config, {
      harnesses: [],
      sandboxes: [boatVm(), boatVm({ type: 'large' }), tartVm(), { kind: 'fake' }],
    }).map((c) => c.line)
    assert.ok(lines.includes('BOAT_API_KEY (for boat())'))
    assert.equal(lines.filter((l) => l.includes('for boat()')).length, 1)
  })

  test('the plan warns of a moving Tart tag, and nothing else asks for warnings', () => {
    assert.match(SANDBOX_KINDS.tart.planWarnings?.(tartVm())[0] ?? '', /moving tag "latest"/)
    assert.deepEqual(
      SANDBOX_KINDS.tart.planWarnings?.(tartVm({ image: `ghcr.io/a/b@sha256:${'a'.repeat(64)}` })),
      [],
    )
    assert.equal(SANDBOX_KINDS.boat.planWarnings, undefined)
  })

  test('only a Tart sandbox on hosts reads a cap from preflight', () => {
    assert.equal(SANDBOX_KINDS.tart.attemptCap?.(tartVm()), null)
    assert.equal(typeof SANDBOX_KINDS.tart.attemptCap?.(tartVm({ hosts: ['mac-1'] })), 'function')
    assert.equal(SANDBOX_KINDS.boat.attemptCap, undefined)
    assert.ok(SANDBOX_KINDS.boat.doctor, "boat()'s account checks")
    assert.equal(SANDBOX_KINDS.tart.doctor, undefined)
  })

  test('the run has a prepare provider for every machine provider, under its kind', () => {
    const providers = createProviders()
    for (const machine of MACHINE_PROVIDERS) {
      assert.equal(providers[machine.kind]?.kind, machine.kind)
    }
  })

  test('each module of the kinds table loads first in a fresh process', () => {
    // kinds.ts builds the machine entries as it loads, so an import cycle back into it throws
    // only when another module of the cycle is the entry point.
    for (const file of ['machines.ts', 'machine.ts', 'kinds.ts', 'providers.ts']) {
      const url = new URL(`../src/sandbox/${file}`, import.meta.url).href
      const r = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--no-warnings',
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(url)})`,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(r.status, 0, `${file}: ${r.stderr}`)
    }
  })

  test('code outside the sandbox modules asks the kinds table, not a machine kind by name', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url))
    const files = [
      'cli.ts',
      'config.ts',
      'doctor.ts',
      'evaluate.ts',
      'options.ts',
      'attempt/environment.ts',
    ]
    for (const file of files) {
      const text = readFileSync(`${src}${file}`, 'utf8')
      assert.doesNotMatch(text, /\.kind [!=]== '(tart|boat)'/, file)
    }
  })
})
