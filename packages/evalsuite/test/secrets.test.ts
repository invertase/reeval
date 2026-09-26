// Tier U for brokered secrets: what resolveEnvironment hands the sandbox and the gateway, which
// secrets the gateway swaps in when, the unbrokered warning's inventory, and encoded redaction.
// The network-level proof (the upstream gets the value, the container never has it) is in
// sandbox-docker's proxy and Docker tests.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Substitution } from '@evalsuite/sandbox-docker'
import { type BrokeredSecret, resolveEnvironment } from '../src/environment/resolve.ts'
import { defineEnvironment, layered, unbrokeredSecrets } from '../src/environment.ts'
import { cursorMcpServers } from '../src/harness/agents.ts'
import type { PlannedAttempt } from '../src/options.ts'
import { unbrokered, unbrokeredWarning } from '../src/options.ts'
import { redactSecrets, registerSecret } from '../src/redact.ts'
import { brokerPhases } from '../src/sandbox/phases.ts'
import type { EnvironmentInput } from '../src/types.ts'

const VALUE = 'es-unit-brokered-4f1c9e2a7b'
const OTHER = 'es-unit-other-9d3a61c0e5'
process.env.ES_UNIT_BROKERED = VALUE
process.env.ES_UNIT_OTHER = OTHER

const PLACEHOLDER = /^es_secret_[0-9A-Za-z]{32}$/

const resolve = (input: EnvironmentInput) =>
  resolveEnvironment(layered(undefined, defineEnvironment('e', input)), {}, '/p', 'e', 'AGENTS.md')

describe('resolving brokered secrets', () => {
  test('the sandbox gets a placeholder, and the gateway the value on its hosts', async () => {
    const r = await resolve(({ secret }) => ({
      env: { API_KEY: secret.fromEnv('ES_UNIT_BROKERED', { hosts: secret.hosts.gemini }) },
    }))
    assert.match(r.vars.API_KEY ?? '', PLACEHOLDER)
    assert.deepEqual(r.substitutions, [
      {
        name: 'API_KEY',
        placeholder: r.vars.API_KEY,
        value: VALUE,
        hosts: ['generativelanguage.googleapis.com'],
        in: ['header'],
        phase: 'agent',
      },
    ])
  })

  test('a value with a line break in it fails the attempt when it would go in a header', async () => {
    process.env.ES_UNIT_WRAPPED = 'AQ.abc\n   │ def'
    try {
      await assert.rejects(
        resolve(({ secret }) => ({
          env: { API_KEY: secret.fromEnv('ES_UNIT_WRAPPED', { hosts: secret.hosts.gemini }) },
        })),
        /^InfraError: API_KEY has whitespace or a line break in it \(character 7\), so it can't go in a request header\. A key copied from a wrapped terminal line picks these up; set it again as one line\.$/,
      )
      // A body-only secret may be anything, a PEM say.
      const r = await resolve(({ secret }) => ({
        env: {
          API_KEY: secret.fromEnv('ES_UNIT_WRAPPED', { hosts: ['api.example.com'], in: ['body'] }),
        },
      }))
      assert.match(r.vars.API_KEY ?? '', PLACEHOLDER)
    } finally {
      delete process.env.ES_UNIT_WRAPPED
    }
  })

  test('the record names the brokered secret, and never has its value or placeholder', async () => {
    const r = await resolve(({ secret }) => ({
      env: { API_KEY: secret.fromEnv('ES_UNIT_BROKERED', { hosts: ['api.example.com'] }) },
    }))
    assert.deepEqual(r.record.brokered, ['API_KEY'])
    assert.deepEqual(r.record.secrets, ['API_KEY'])
    const record = JSON.stringify(r.record)
    assert.equal(record.includes(VALUE), false)
    assert.equal(record.includes(r.vars.API_KEY ?? '?'), false)
  })

  test('twin: the same search finds the secret name in the record', async () => {
    const r = await resolve(({ secret }) => ({
      env: { API_KEY: secret.fromEnv('ES_UNIT_BROKERED', { hosts: ['api.example.com'] }) },
    }))
    assert.equal(JSON.stringify(r.record).includes('API_KEY'), true)
  })

  test('each attempt gets a fresh placeholder, and the digest stays the same', async () => {
    const input: EnvironmentInput = ({ secret }) => ({
      env: { API_KEY: secret.fromEnv('ES_UNIT_BROKERED', { hosts: ['api.example.com'] }) },
    })
    const [a, b] = [await resolve(input), await resolve(input)]
    assert.notEqual(a.vars.API_KEY, b.vars.API_KEY)
    assert.equal(a.record.digest, b.record.digest)
  })

  test('the digest covers hosts and in', async () => {
    const digest = async (options: object) =>
      (
        await resolve(({ secret }) => ({
          env: { API_KEY: secret.fromEnv('ES_UNIT_BROKERED', options) },
        }))
      ).record.digest
    const base = await digest({ hosts: ['api.example.com'] })
    assert.notEqual(await digest({}), base)
    assert.notEqual(await digest({ hosts: ['api.example.org'] }), base)
    assert.notEqual(await digest({ hosts: ['api.example.com'], in: ['header', 'body'] }), base)
  })

  test("a to: 'checks' secret gives the checks a placeholder, brokered in the checks phase", async () => {
    const r = await resolve(({ secret }) => ({
      env: {
        CHECK_KEY: secret.fromEnv('ES_UNIT_BROKERED', { to: 'checks', hosts: ['api.example.com'] }),
      },
    }))
    assert.equal(r.vars.CHECK_KEY, undefined)
    assert.match(r.checkVars.CHECK_KEY ?? '', PLACEHOLDER)
    assert.equal(r.substitutions[0]?.phase, 'checks')
    assert.equal(r.substitutions[0]?.placeholder, r.checkVars.CHECK_KEY)
  })

  test('a secret without hosts is still the real value', async () => {
    const r = await resolve(({ secret }) => ({ env: { API_KEY: secret.fromEnv('ES_UNIT_OTHER') } }))
    assert.equal(r.vars.API_KEY, OTHER)
    assert.deepEqual(r.substitutions, [])
    assert.deepEqual(r.record.brokered, [])
  })

  test("MCP header secrets are brokered to the server's own host over HTTPS", async () => {
    const r = await resolve(({ secret, mcp }) => ({
      mcp: {
        docs: mcp.http('https://mcp.example.com/v1', {
          headers: {
            'x-api-key': secret.fromEnv('ES_UNIT_BROKERED'),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
            authorization: secret.template('Bearer ${ES_UNIT_OTHER}'),
          },
        }),
      },
    }))
    const server = r.mcp.docs
    assert.ok(server && server.transport === 'http')
    assert.match(server.headers['x-api-key'] ?? '', PLACEHOLDER)
    assert.match(server.headers.authorization ?? '', /^Bearer es_secret_[0-9A-Za-z]{32}$/)
    // What the Cursor adapter forwards to the agent: the placeholders, never the values.
    const forwarded = JSON.stringify(cursorMcpServers(r.mcp))
    assert.ok(forwarded.includes(server.headers['x-api-key'] ?? '?'))
    assert.equal(forwarded.includes(VALUE) || forwarded.includes(OTHER), false)
    assert.deepEqual(
      r.substitutions.map((s) => [s.name, s.value, s.hosts]),
      [
        ['x-api-key', VALUE, ['mcp.example.com']],
        ['ES_UNIT_OTHER', OTHER, ['mcp.example.com']],
      ],
    )
  })

  test('MCP header secrets on plain HTTP stay real values', async () => {
    const r = await resolve(({ secret, mcp }) => ({
      mcp: {
        local: mcp.http('http://localhost:3333', {
          headers: { 'x-api-key': secret.fromEnv('ES_UNIT_BROKERED') },
        }),
      },
    }))
    const server = r.mcp.local
    assert.ok(server && server.transport === 'http')
    assert.equal(server.headers['x-api-key'], VALUE)
    assert.deepEqual(r.substitutions, [])
  })

  test('MCP stdio env secrets are brokered only with explicit hosts', async () => {
    const r = await resolve(({ secret, mcp }) => ({
      mcp: {
        gh: mcp.stdio('gh-mcp', [], {
          env: {
            GITHUB_TOKEN: secret.fromEnv('ES_UNIT_BROKERED', { hosts: secret.hosts.github }),
            OTHER_TOKEN: secret.fromEnv('ES_UNIT_OTHER'),
          },
        }),
      },
    }))
    const server = r.mcp.gh
    assert.ok(server && server.transport === 'stdio')
    assert.match(server.env.GITHUB_TOKEN ?? '', PLACEHOLDER)
    assert.equal(server.env.OTHER_TOKEN, OTHER)
    assert.deepEqual(r.record.brokered, ['GITHUB_TOKEN'])
  })
})

describe('broker phases', () => {
  const sub = (name: string, phase: BrokeredSecret['phase']): BrokeredSecret => ({
    name,
    placeholder: `es_secret_${name}`,
    value: `value-${name}`,
    hosts: ['api.example.com'],
    in: ['header'],
    phase,
  })
  const recorder = () => {
    const calls: string[][] = []
    return {
      calls,
      last: () => calls.at(-1),
      async setSubstitutions(subs: readonly Substitution[]) {
        assert.equal(
          subs.some((s) => 'phase' in s),
          false,
          'the gateway gets substitutions only',
        )
        calls.push(subs.map((s) => s.name))
      },
    }
  }

  test("the agent's secrets are active from the start, the checks' only during a check", async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('AGENT', 'agent'), sub('CHECK', 'checks')])
    await phases.start()
    assert.deepEqual(box.last(), ['AGENT'])
    const during = await phases.checks(async () => box.last())
    assert.deepEqual(during, ['AGENT', 'CHECK'])
    assert.deepEqual(box.last(), ['AGENT'])
  })

  test('twin: during a check, the checks secret is active', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('CHECK', 'checks')])
    await phases.start()
    assert.deepEqual(await phases.checks(async () => box.last()), ['CHECK'])
  })

  test('overlapping checks keep the checks phase until the last one ends', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('CHECK', 'checks')])
    await phases.start()
    let release = () => {}
    const slow = phases.checks(() => new Promise<void>((r) => (release = r)))
    await phases.checks(async () => {})
    assert.deepEqual(box.last(), ['CHECK'], 'the slow check is still running')
    release()
    await slow
    assert.deepEqual(box.last(), [])
  })

  test('a failing check still ends the checks phase', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('CHECK', 'checks')])
    await phases.start()
    await assert.rejects(
      phases.checks(async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.deepEqual(box.last(), [])
  })

  test('with no checks secrets, checks change nothing', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('AGENT', 'agent')])
    await phases.start()
    await phases.checks(async () => {})
    assert.deepEqual(box.calls, [['AGENT']])
  })

  test('a sandbox without a gateway runs checks as they are', async () => {
    const phases = brokerPhases({}, [sub('CHECK', 'checks')])
    await phases.start()
    assert.equal(await phases.checks(async () => 'ran'), 'ran')
  })
})

describe('unbrokered secrets', () => {
  test('lists env and MCP secrets the sandbox would get as real values', () => {
    const env = defineEnvironment('e', ({ secret, mcp }) => ({
      env: {
        PLAIN: secret.fromEnv('HOST_PLAIN'),
        BROKERED: secret.fromEnv('HOST_BROKERED', { hosts: ['api.example.com'] }),
      },
      mcp: {
        stdio: mcp.stdio('x', [], { env: { STDIO_KEY: secret() } }),
        remote: mcp.http('https://mcp.example.com', { headers: { auth: secret() } }),
        local: mcp.http('http://localhost:1', {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
          headers: { auth: secret.template('Bearer ${LOCAL_TOKEN}') },
        }),
      },
    }))
    assert.deepEqual(unbrokeredSecrets({ OPT: { kind: 'secret' } }, env.layers), [
      { label: 'OPT', from: 'OPT' },
      { label: 'PLAIN', from: 'HOST_PLAIN' },
      { label: 'mcp.stdio.env.STDIO_KEY', from: 'STDIO_KEY' },
      { label: 'mcp.local.headers.auth', from: 'LOCAL_TOKEN' },
    ])
  })

  test('a later layer that brokers a variable leaves nothing unbrokered', () => {
    const parent = defineEnvironment('parent', ({ secret }) => ({ env: { KEY: secret() } }))
    const child = parent.extend('child', ({ secret }) => ({
      env: { KEY: secret({ hosts: ['api.example.com'] }) },
    }))
    assert.deepEqual(unbrokeredSecrets({}, child.layers), [])
  })

  test('twin: a later layer that drops hosts is unbrokered', () => {
    const parent = defineEnvironment('parent', ({ secret }) => ({
      env: { KEY: secret({ hosts: ['api.example.com'] }) },
    }))
    const child = parent.extend('child', ({ secret }) => ({ env: { KEY: secret() } }))
    assert.deepEqual(unbrokeredSecrets({}, child.layers), [{ label: 'KEY', from: 'KEY' }])
  })

  test("a to: 'checks' secret's warning says the agent never gets it", () => {
    assert.equal(
      unbrokeredWarning({ label: 'CHECK_TOKEN', from: 'CHECK_TOKEN', checksOnly: true }),
      "CHECK_TOKEN reaches the checks (t.exec, setup steps) as its real value; the agent never gets it. To give the checks only a placeholder, add the hosts it's sent to, e.g. secret.fromEnv('CHECK_TOKEN', { hosts: ['api.example.com'] }).",
    )
    const env = { CHECK_TOKEN: { kind: 'secret' as const, to: 'checks' as const } }
    const [found] = unbrokeredSecrets(env, [])
    assert.deepEqual(found, { label: 'CHECK_TOKEN', from: 'CHECK_TOKEN', checksOnly: true })
    assert.match(
      unbrokeredWarning({ label: 'PLAIN', from: 'PLAIN' }),
      /^PLAIN is in the sandbox as its real value/,
    )
  })

  test('only Docker attempts count', () => {
    const env = defineEnvironment('e', ({ secret }) => ({ env: { PLAIN: secret() } }))
    const attempt = (kind: 'fake' | 'docker') =>
      ({ sandbox: { kind }, environment: layered(undefined, env) }) as PlannedAttempt
    assert.deepEqual(unbrokered({}, [attempt('fake')]), [])
    assert.deepEqual(unbrokered({}, [attempt('docker'), attempt('docker')]), [
      { label: 'PLAIN', from: 'PLAIN' },
    ])
  })
})

describe('redacting encoded forms', () => {
  const value = 'es unit/leak+7c"1d&9a?0b'
  registerSecret(value)
  const cases: Array<[string, string]> = [
    ['raw', value],
    ['JSON-escaped', JSON.stringify(value).slice(1, -1)],
    ['JSON-escaped twice', JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1)],
    ['URL-encoded', encodeURIComponent(value)],
    ['form-encoded', new URLSearchParams({ v: value }).toString().slice(2)],
    ['base64', Buffer.from(value).toString('base64')],
    ['base64url', Buffer.from(value).toString('base64url')],
    ['base64 at offset 1', Buffer.from(`a${value}`).toString('base64')],
    ['base64 at offset 2', Buffer.from(`ab${value}`).toString('base64')],
    ['base64 in a Basic header', Buffer.from(`user:${value}`).toString('base64')],
  ]
  for (const [what, form] of cases) {
    test(`masks the ${what} form`, () => {
      const out = redactSecrets(`before ${form} after`, {})
      assert.match(out, /\[REDACTED\]/)
      assert.equal(out.includes(form), false)
    })
  }

  test('twin: a form the redactor does not know (hex) is left as is', () => {
    const hex = Buffer.from(value).toString('hex')
    assert.equal(redactSecrets(hex, {}), hex)
  })
})
