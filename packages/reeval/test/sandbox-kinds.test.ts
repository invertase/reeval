// The sandbox kind registry: every kind answers for itself, and what planning and the attempt ask
// of a sandbox (egress, brokering, a harness session, the platform) comes from its capabilities.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { setupAllowance } from '../src/attempt/index.ts'
import { resolveConfig } from '../src/config.ts'
import { SANDBOX_EGRESS } from '../src/egress.ts'
import { agentSandboxProblem } from '../src/harness/agent.ts'
import { AGENTS, unverifiedHarness } from '../src/harness/agents.ts'
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
import { classifyTart, createProviders, tartHostProblem } from '../src/sandbox/providers.ts'
import { docker, fakeSandbox, podman, tart } from '../src/sandbox.ts'
import { boat } from '../src/sandbox-boat.ts'
import type { SandboxDescriptor } from '../src/types.ts'

const IMAGE = 'ghcr.io/cirruslabs/macos-sequoia-base:latest'

describe('sandbox kinds', () => {
  test('every kind is in the table, and nothing else is a kind', () => {
    assert.deepEqual(Object.keys(SANDBOX_KINDS).sort(), ['boat', 'docker', 'fake', 'tart'])
    assert.ok(isSandboxKind('docker'))
    assert.ok(isSandboxKind('tart'))
    assert.ok(!isSandboxKind('vm'))
    assert.ok(!isSandboxKind('toString'))
    assert.ok(!isSandboxKind(undefined))
  })

  test('each kind names its helpers, and messages list them all', () => {
    assert.equal(sandboxHelpers(), 'docker(), podman(), fakeSandbox(), tart() or boat()')
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
      harnesses: 'all',
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
      harnesses: 'all',
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
      harnesses: 'all',
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
      harnesses: 'all',
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
  const cursor = { kind: 'cursor', model: 'composer-2.5' } as const

  test('one with a harness session that brokers, on a platform its bootstrap installs', () => {
    assert.equal(agentSandboxProblem(cursor, AGENTS.cursor, docker()), undefined)
    assert.equal(
      agentSandboxProblem({ kind: 'codex', model: 'gpt-5' }, AGENTS.codex, podman()),
      undefined,
    )
  })

  test('the fake sandbox names what it lacks and the sandbox that has it', () => {
    assert.equal(
      agentSandboxProblem(cursor, AGENTS.cursor, fakeSandbox()),
      "The Cursor harness can't run in the fake sandbox, which has no harness session and can't keep CURSOR_API_KEY out of it: set sandbox: docker() or tart() or boat() for this eval, or use fakeHarness() with fakeSandbox()",
    )
  })

  test('Boat runs every harness, each of whose bootstraps installs for Linux', () => {
    for (const kind of Object.keys(AGENTS) as (keyof typeof AGENTS)[]) {
      const harness = { kind, model: 'm' } as HarnessDescriptor
      assert.equal(agentSandboxProblem(harness, AGENTS[kind], boat()), undefined, kind)
      assert.equal(unverifiedHarness(harness, boat()), undefined, kind)
    }
    assert.equal(unverifiedHarness({ kind: 'fake' }, boat()), undefined)
  })

  test('Tart runs every harness, each of whose bootstraps installs for macOS', () => {
    const mac = tart({ image: IMAGE })
    for (const kind of Object.keys(AGENTS) as (keyof typeof AGENTS)[]) {
      const harness = { kind, model: 'm' } as HarnessDescriptor
      assert.equal(agentSandboxProblem(harness, AGENTS[kind], mac), undefined, kind)
      assert.equal(unverifiedHarness(harness, mac), undefined, kind)
    }
    assert.equal(unverifiedHarness({ kind: 'fake' }, mac), undefined)
  })

  test("the fake sandbox's platform is the host's, which it never names", () => {
    const aixOnly = { ...AGENTS.cursor, platforms: ['aix'] as const }
    assert.doesNotMatch(agentSandboxProblem(cursor, aixOnly, fakeSandbox()) ?? '', /runs /)
  })

  test('a platform no sandbox runs leaves only the fake harness', () => {
    const windowsOnly = { ...AGENTS.cursor, platforms: ['win32'] as const }
    assert.equal(
      agentSandboxProblem(cursor, windowsOnly, docker()),
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
