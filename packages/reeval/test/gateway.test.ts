// The gateway resolver and Vercel's routes as data: fallback, pins, the plan's hint, what a
// harness on Vercel authenticates with and is brokered on, and its credential's expiry.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { fallbackHint, resolveGateway } from '../src/gateway/resolve.ts'
import {
  jwtExpiry,
  VERCEL_ROUTES,
  vercelCredential,
  vercelCredentialProblem,
} from '../src/gateway/vercel.ts'
import { agentAuth, agentFor } from '../src/harness/agents.ts'
import { gatewayPart } from '../src/history/assemble.ts'
import type { AgentHarnessDescriptor, HarnessDescriptor } from '../src/types.ts'

const WHERE = 'evaluate("e")'
const cursor = { kind: 'cursor', model: 'composer-2.5' } as HarnessDescriptor
const codex = { kind: 'codex', model: 'gpt-5.4-mini' } as HarnessDescriptor
const claude = { kind: 'claude-code', model: 'claude-sonnet-4-5' } as HarnessDescriptor
const pinned = (h: HarnessDescriptor, gateway: string) => ({ ...h, gateway }) as HarnessDescriptor
const list = (...kinds: string[]) => kinds.map((kind) => ({ kind }))
const resolve = (gateways: { kind: string }[], h: HarnessDescriptor) =>
  resolveGateway(gateways, h, WHERE)
const CURSOR_WHY = "Cursor's agent only calls Cursor's own API"
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`

describe('resolveGateway', () => {
  test('each harness takes the first gateway that can serve it', () => {
    assert.deepEqual(resolve(list('vercel', 'direct'), codex), { name: 'vercel', skipped: [] })
    assert.deepEqual(resolve(list('vercel', 'direct'), claude), { name: 'vercel', skipped: [] })
    assert.deepEqual(resolve(list('direct', 'vercel'), codex), { name: 'direct', skipped: [] })
    assert.deepEqual(resolve(list('vercel', 'direct'), cursor), {
      name: 'direct',
      skipped: [{ gateway: 'vercel', why: CURSOR_WHY }],
    })
  })

  test('a fake harness calls no model, so any gateway serves it', () => {
    assert.deepEqual(resolve(list('vercel'), { kind: 'fake' }), { name: 'vercel', skipped: [] })
  })

  test('the plan hint names where a harness fell to, and why', () => {
    assert.equal(
      fallbackHint('cursor:composer-2.5', resolve(list('vercel', 'direct'), cursor)),
      `gateway: cursor:composer-2.5 → direct (vercel can't serve it: ${CURSOR_WHY})`,
    )
  })

  test('nothing in the list serving it exits 2, naming each gateway tried', () => {
    assert.throws(() => resolve(list('vercel'), cursor), {
      name: 'UsageError',
      message: `evaluate("e") on cursor:composer-2.5: no gateway in the list can serve it (vercel: ${CURSOR_WHY}). Add direct() to the end of gateway to use Cursor's own key.`,
    })
  })

  test('a pin skips the fallback, and must be listed and able to serve', () => {
    assert.deepEqual(resolve(list('vercel', 'direct'), pinned(codex, 'direct')), {
      name: 'direct',
      skipped: [],
    })
    assert.deepEqual(resolve(list('direct', 'vercel'), pinned(codex, 'vercel')), {
      name: 'vercel',
      skipped: [],
    })
    assert.throws(() => resolve(list('direct'), pinned(codex, 'vercel')), {
      message:
        "evaluate(\"e\") on codex:gpt-5.4-mini: it pins gateway 'vercel', which isn't in the gateway list (direct). Add vercel() to gateway, or pin one that's there.",
    })
    assert.throws(() => resolve(list('vercel', 'direct'), pinned(cursor, 'vercel')), {
      message: `evaluate("e") on cursor:composer-2.5: it pins gateway 'vercel', which can't serve it (${CURSOR_WHY}). A pin never falls back; pin another gateway, or remove the pin to take the first in the list that can.`,
    })
  })

  test('only a gateway other than direct joins the fingerprint', () => {
    assert.deepEqual(gatewayPart(undefined), {})
    assert.deepEqual(gatewayPart({ name: 'direct', skipped: [] }), {})
    assert.deepEqual(
      gatewayPart({ name: 'vercel', skipped: [] }),
      { gateway: 'vercel' },
      'a new route is a new measurement',
    )
  })
})

describe('Vercel AI Gateway routes', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })
  const onVercel = (h: HarnessDescriptor) =>
    agentFor({ ...h, gateway: 'vercel' } as AgentHarnessDescriptor)

  test('Claude Code takes the key as AI_GATEWAY_API_KEY and is brokered only on Vercel', () => {
    delete process.env.VERCEL_OIDC_TOKEN
    const agent = onVercel(claude)
    assert.equal(agent.credential, 'AI_GATEWAY_API_KEY')
    assert.deepEqual(agent.hosts, ['ai-gateway.vercel.sh'])
    assert.ok(agent.endpoints.every((e) => e.host === 'ai-gateway.vercel.sh'))
    assert.deepEqual(
      agent.endpoints.map((e) => [e.method, e.path]),
      [
        [['POST'], { exact: '/v1/messages' }],
        [['POST'], { exact: '/v1/messages/count_tokens' }],
        [['GET'], { exact: '/api/claude_code/settings' }],
        [['GET'], { exact: '/api/claude_code/policy_limits' }],
      ],
    )
    assert.equal(agent.modelId, undefined, "Claude Code's ids are Vercel's")
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    assert.deepEqual(agentAuth(agent), { AI_GATEWAY_API_KEY: 'vck_test' })
  })

  test("Codex reads the served model from Vercel's responses and names OpenAI's models", () => {
    const agent = onVercel(codex)
    assert.deepEqual(
      agent.endpoints.map((e) => [e.host, e.path]),
      [['ai-gateway.vercel.sh', { exact: '/v1/responses' }]],
    )
    assert.deepEqual(agent.modelResponses, agent.endpoints)
    assert.equal(
      agent.servedModel?.({ host: 'ai-gateway.vercel.sh', responseModel: 'openai/gpt-5' } as never),
      'openai/gpt-5',
    )
    assert.equal(
      agent.servedModel?.({ host: 'api.openai.com', responseModel: 'gpt-5' } as never),
      undefined,
    )
    assert.equal(agent.modelId?.('gpt-5.4-mini'), 'openai/gpt-5.4-mini')
    assert.equal(agent.modelId?.('openai/gpt-5.4-mini'), 'openai/gpt-5.4-mini')
  })

  test('off Vercel, a harness keeps its own credential and endpoints', () => {
    const agent = agentFor(codex as AgentHarnessDescriptor)
    assert.equal(agent.credential, 'OPENAI_API_KEY')
    assert.equal(agent.authAs, undefined)
    assert.ok(agent.endpoints.every((e) => e.host !== 'ai-gateway.vercel.sh'))
  })

  test('a Vercel project token stands in for the key, which wins when both are set', () => {
    assert.equal(vercelCredential({}), 'AI_GATEWAY_API_KEY')
    assert.equal(vercelCredential({ VERCEL_OIDC_TOKEN: 't' }), 'VERCEL_OIDC_TOKEN')
    assert.equal(
      vercelCredential({ VERCEL_OIDC_TOKEN: 't', AI_GATEWAY_API_KEY: 'k' }),
      'AI_GATEWAY_API_KEY',
    )
    process.env.VERCEL_OIDC_TOKEN = 'oidc'
    delete process.env.AI_GATEWAY_API_KEY
    const agent = onVercel(claude)
    assert.equal(agent.credential, 'VERCEL_OIDC_TOKEN')
    assert.deepEqual(
      agentAuth(agent),
      { AI_GATEWAY_API_KEY: 'oidc' },
      'the adapter takes it as the key',
    )
    assert.deepEqual(VERCEL_ROUTES['claude-code']?.(process.env).authAs, 'AI_GATEWAY_API_KEY')
  })

  test("an expired project token is refused before the run; a live one, or a key, isn't", () => {
    const noon = new Date('2026-01-01T12:00:00Z')
    const at = (iso: string) => Date.parse(iso) / 1000
    assert.equal(
      jwtExpiry(jwt(at('2026-01-01T00:00:00Z')))?.toISOString(),
      '2026-01-01T00:00:00.000Z',
    )
    assert.equal(jwtExpiry('opaque'), undefined)
    assert.equal(jwtExpiry('a.!!!.c'), undefined)
    assert.match(
      vercelCredentialProblem({ VERCEL_OIDC_TOKEN: jwt(at('2026-01-01T00:00:00Z')) }, noon) ?? '',
      /^VERCEL_OIDC_TOKEN expired at 2026-01-01T00:00:00\.000Z/,
    )
    assert.equal(
      vercelCredentialProblem({ VERCEL_OIDC_TOKEN: jwt(at('2026-01-01T13:00:00Z')) }, noon),
      undefined,
    )
    assert.equal(
      vercelCredentialProblem(
        { VERCEL_OIDC_TOKEN: jwt(at('2026-01-01T00:00:00Z')), AI_GATEWAY_API_KEY: 'k' },
        noon,
      ),
      undefined,
    )
  })
})
