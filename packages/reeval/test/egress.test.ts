// Egress policies before anything runs: the cascade, the automatic hosts, what a sandbox can
// enforce, and what the environment digest covers. The traffic itself is in the egress/*
// feature fixtures and sandbox-docker's tests.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  allowedHosts,
  DEFAULT_EGRESS_ALLOW,
  egressLabel,
  egressNeeds,
  gatewayPolicy,
  plannedEgress,
  SANDBOX_EGRESS,
  unenforceable,
} from '../src/egress.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment } from '../src/environment.ts'
import { cascade, expand, type Resolved } from '../src/options.ts'
import type { EgressPolicy, HarnessDescriptor } from '../src/types.ts'

const fake: HarnessDescriptor = { kind: 'fake' }
const layers = (...specs: Array<EgressPolicy | undefined>) =>
  specs.map((egress, i) => ({ name: `l${i}`, spec: egress === undefined ? {} : { egress } }))

describe('the egress cascade', () => {
  test('config and profile defaults, then the environment, then groups and the eval', () => {
    const inherited: EgressPolicy = { allow: ['config.example.com'] }
    const at = (own?: EgressPolicy, ...env: Array<EgressPolicy | undefined>) =>
      plannedEgress({ inherited, ...(own ? { own } : {}) }, fake, {}, layers(...env)).policy
    assert.deepEqual(at(), inherited, 'the config applies with no environment policy')
    assert.equal(at(undefined, 'deny-all'), 'deny-all', 'the environment replaces the config')
    assert.equal(at(undefined, 'deny-all', 'allow-all'), 'allow-all', 'the last layer wins')
    assert.equal(at(undefined, 'deny-all', undefined), 'deny-all', 'a layer without one keeps it')
    assert.deepEqual(at({ allow: ['e.example.com'] }, 'deny-all'), { allow: ['e.example.com'] })
    assert.equal(plannedEgress({}, fake, {}, []).policy, 'allow-all', 'the default')
  })

  test('cascade puts the config and profile under the environment, groups and the eval over it', () => {
    const base: Resolved = {
      harness: [fake],
      sandbox: { kind: 'docker' },
      environment: defineEnvironment('closed', { egress: 'deny-all' }),
      compare: undefined,
      runs: 1,
      gate: undefined,
      env: {},
      egress: { inherited: { allow: ['config.example.com'] } },
      judge: {},
      capture: {},
      timeout: undefined,
      tags: [],
      pin: [],
    }
    const profile = {
      name: 'p',
      reason: '--profile',
      defaults: { egress: { allow: ['profile.example.com'] } },
      limit: {},
      judge: {},
      tags: [],
      budget: {},
    }
    const policyOf = (levels: Parameters<typeof cascade>[1]) =>
      expand(cascade(base, levels, 'e', { profile }).resolved)[0]?.egress.policy
    assert.equal(policyOf([{ options: {}, where: 'e' }]), 'deny-all')
    const group = { options: { egress: { allow: ['group.example.com'] } }, where: 'g' }
    assert.deepEqual(policyOf([group, { options: {}, where: 'e' }]), {
      allow: ['group.example.com'],
    })
    assert.equal(policyOf([group, { options: { egress: 'allow-all' }, where: 'e' }]), 'allow-all')
    const open = cascade({ ...base, environment: undefined }, [], 'e', { profile })
    assert.deepEqual(open.resolved.egress, { inherited: { allow: ['profile.example.com'] } })
  })
})

describe('automatic hosts', () => {
  test("a restricted policy adds the harness's, brokered secrets' and MCP servers' hosts", () => {
    const env = defineEnvironment('svc', ({ mcp, secret }) => ({
      egress: { allow: ['api.example.com'] },
      env: { KEY: secret({ hosts: ['api.example.com', '*.upload.example.com'] }), PLAIN: 'x' },
      mcp: { docs: mcp.sse('http://mcp.example.com/sse'), local: mcp.stdio('node') },
    }))
    const cursor: HarnessDescriptor = { kind: 'cursor' }
    const planned = plannedEgress({}, cursor, {}, env.layers)
    assert.deepEqual(planned.auto, [
      'api2.cursor.sh',
      '*.cursor.sh',
      '*.upload.example.com',
      'mcp.example.com',
    ])
    assert.deepEqual(allowedHosts(planned), ['api.example.com', ...planned.auto])
    assert.equal(
      egressLabel(planned).startsWith('allow api.example.com + auto: api2.cursor.sh'),
      true,
    )
  })

  test("a fake agent adds its layout's hosts only when it names one", () => {
    const deny = layers('deny-all')
    assert.deepEqual(plannedEgress({}, fake, {}, deny).auto, [])
    assert.deepEqual(plannedEgress({}, { kind: 'fake', layout: 'claude-code' }, {}, deny).auto, [
      'api.anthropic.com',
      '*.anthropic.com',
    ])
  })

  test('secrets from the options env count, and allow-all adds nothing', () => {
    const env = defineEnvironment('e', ({ secret }) => ({
      env: { K: secret({ hosts: ['k.example.com'] }) },
    }))
    const options = { O: { kind: 'secret' as const, hosts: ['o.example.com'] } }
    assert.deepEqual(plannedEgress({ own: 'deny-all' }, fake, options, env.layers).auto, [
      'o.example.com',
      'k.example.com',
    ])
    assert.deepEqual(plannedEgress({}, { kind: 'cursor' }, options, env.layers), {
      policy: 'allow-all',
      auto: [],
    })
    assert.equal(allowedHosts({ policy: 'allow-all', auto: [] }), null)
  })

  test("the gateway's policy: listed IP addresses are its allowed ranges too", () => {
    const auto = ['api2.cursor.sh']
    assert.deepEqual(gatewayPolicy({ policy: { allow: ['10.1.2.3', 'db.internal'] }, auto }), {
      mode: 'custom',
      allowedHosts: ['10.1.2.3', 'db.internal', 'api2.cursor.sh'],
      allowedCIDRs: ['10.1.2.3/32'],
    })
    // Twin: without an address there are no ranges, and the other policies map as they are.
    assert.deepEqual(gatewayPolicy({ policy: { allow: ['db.internal'] }, auto }), {
      mode: 'custom',
      allowedHosts: ['db.internal', 'api2.cursor.sh'],
    })
    assert.deepEqual(gatewayPolicy({ policy: 'deny-all', auto: [] }), { mode: 'deny-all' })
    assert.deepEqual(gatewayPolicy({ policy: 'allow-all', auto: [] }), { mode: 'allow-all' })
  })

  test('DEFAULT_EGRESS_ALLOW is the registries and GitHub, and frozen', () => {
    assert.ok(DEFAULT_EGRESS_ALLOW.includes('registry.npmjs.org'))
    assert.ok(DEFAULT_EGRESS_ALLOW.includes('*.githubusercontent.com'))
    assert.ok(
      !DEFAULT_EGRESS_ALLOW.some((h) => h.includes('cursor')),
      'harness hosts are automatic',
    )
    assert.throws(() => (DEFAULT_EGRESS_ALLOW as string[]).push('x'))
  })
})

describe('what a sandbox can enforce', () => {
  test('each provider declares it: Docker all of it and recording, the fake nothing', () => {
    assert.deepEqual(SANDBOX_EGRESS, {
      docker: { enforce: 'allowlist', record: true },
      fake: { enforce: 'none', record: false },
    })
  })

  test('a policy needs nothing, egress off, or an allowlist once any host is allowed', () => {
    assert.equal(egressNeeds({ policy: 'allow-all', auto: [] }), 'none')
    assert.equal(egressNeeds({ policy: 'deny-all', auto: [] }), 'all-or-nothing')
    assert.equal(egressNeeds({ policy: { allow: [] }, auto: [] }), 'all-or-nothing')
    assert.equal(egressNeeds({ policy: 'deny-all', auto: ['api2.cursor.sh'] }), 'allowlist')
    assert.equal(egressNeeds({ policy: { allow: ['a.example.com'] }, auto: [] }), 'allowlist')
  })

  test('the fake sandbox refuses every restricted policy; Docker takes them all', () => {
    const policies = [
      { policy: 'deny-all', auto: [] },
      { policy: { allow: ['a.example.com'] }, auto: [] },
    ] as const
    for (const p of policies) {
      assert.match(unenforceable(p, { kind: 'fake' }, 'e') ?? '', /the fake sandbox enforces no/)
      assert.equal(unenforceable(p, { kind: 'docker' }, 'e'), undefined)
    }
    // Twin: allow-all needs nothing, so the fake sandbox takes it.
    assert.equal(unenforceable({ policy: 'allow-all', auto: [] }, { kind: 'fake' }, 'e'), undefined)
  })
})

describe('the environment digest', () => {
  const digest = async (egress?: EgressPolicy) =>
    (
      await resolveEnvironment(
        applied(defineEnvironment('e', {})),
        {},
        '/p',
        'e',
        'AGENTS.md',
        egress,
      )
    ).record

  test('covers a restricted policy, not the order of its hosts; allow-all leaves it as it was', async () => {
    const none = await digest()
    assert.equal((await digest('allow-all')).digest, none.digest)
    assert.notEqual((await digest('deny-all')).digest, none.digest)
    const ab = await digest({ allow: ['a.example.com', 'b.example.com'] })
    const ba = await digest({ allow: ['b.example.com', 'a.example.com'] })
    assert.equal(ab.digest, ba.digest)
    assert.notEqual(ab.digest, (await digest({ allow: ['a.example.com'] })).digest)
    assert.deepEqual(ab.egress, { allow: ['a.example.com', 'b.example.com'] })
    assert.equal(none.egress, 'allow-all')
  })

  test("an extend child's policy is an override", async () => {
    const parent = defineEnvironment('p', { egress: 'deny-all' })
    const child = parent.extendEnvironment('c', { egress: { allow: ['a.example.com'] } })
    const r = await resolveEnvironment(applied(child), {}, '/p', 'e', 'AGENTS.md')
    assert.deepEqual(r.record.overrides, ['egress'])
  })
})
