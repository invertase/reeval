// The sandbox kind registry: every kind answers for itself, and what planning and the attempt ask
// of a sandbox (egress, brokering, a harness session, the platform) comes from its capabilities.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SANDBOX_EGRESS } from '../src/egress.ts'
import { agentSandboxProblem } from '../src/harness/agent.ts'
import { AGENTS } from '../src/harness/agents.ts'
import {
  capabilitiesOf,
  isSandboxKind,
  SANDBOX_KINDS,
  sandboxHelpers,
  sandboxKind,
  suggestedSandbox,
} from '../src/sandbox/kinds.ts'
import { createProviders } from '../src/sandbox/providers.ts'
import { docker, fakeSandbox, podman } from '../src/sandbox.ts'

describe('sandbox kinds', () => {
  test('every kind is in the table, and nothing else is a kind', () => {
    assert.deepEqual(Object.keys(SANDBOX_KINDS).sort(), ['docker', 'fake'])
    assert.ok(isSandboxKind('docker'))
    assert.ok(!isSandboxKind('tart'))
    assert.ok(!isSandboxKind('toString'))
    assert.ok(!isSandboxKind(undefined))
  })

  test('each kind names its helpers, and messages list them all', () => {
    assert.equal(sandboxHelpers(), 'docker(), podman() or fakeSandbox()')
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
    for (const sandbox of [docker(), podman(), fakeSandbox()]) {
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
      egress: { enforce: 'allowlist', record: true },
      brokers: true,
      harnessSession: true,
      isolated: true,
      processTable: true,
      images: true,
      pluginBuilds: true,
    })
    assert.deepEqual(capabilitiesOf(fakeSandbox()), {
      platform: process.platform,
      egress: { enforce: 'none', record: false },
      brokers: false,
      harnessSession: false,
      isolated: false,
      processTable: false,
      images: false,
      pluginBuilds: false,
    })
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
      "The Cursor harness can't run in the fake sandbox, which has no harness session and can't keep CURSOR_API_KEY out of it: set sandbox: docker() for this eval, or use fakeHarness() with fakeSandbox()",
    )
  })

  test('a platform no sandbox runs leaves only the fake harness', () => {
    const darwinOnly = { ...AGENTS.cursor, platforms: ['darwin'] as const }
    assert.equal(
      agentSandboxProblem(darwinOnly, docker()),
      "The Cursor harness can't run in the docker sandbox, which runs linux, not darwin: use fakeHarness() with fakeSandbox()",
    )
  })
})
