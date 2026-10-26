// The gateway resolver and Vercel's and OpenRouter's routes as data: fallback, pins, the plan's
// hint, the models reeval calls itself, what a harness on each authenticates with and is brokered
// on, the upstream OpenRouter names, and Vercel's credential's expiry.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { openCodeConfig } from '@reeval/harness-opencode'
import { onEndpoint } from '@reeval/sandbox-docker'
import { type GatewayScope, resolveModelGateway } from '../src/gateway/models.ts'
import {
  anthropicOnOpenRouter,
  OPENROUTER_GATEWAY,
  upstreamOnOpenRouter,
} from '../src/gateway/openrouter.ts'
import { openRouterBilling, openRouterFallbacks } from '../src/gateway/openrouter-models.ts'
import { fallbackHint, resolveGateway } from '../src/gateway/resolve.ts'
import { brokerToken, cachedTokenSource, RETRY_MS } from '../src/gateway/token.ts'
import {
  jwtExpiry,
  VERCEL_GATEWAY,
  vercelCredential,
  vercelCredentialProblem,
} from '../src/gateway/vercel.ts'
import {
  SANDBOX_ACCESS_TOKEN,
  vertexDecisionModel,
  vertexHost,
  vertexLanguageModel,
  vertexModelRefusal,
  vertexRegion,
  vertexSettings,
} from '../src/gateway/vertex.ts'
import { everyCallFailed } from '../src/harness/agent.ts'
import {
  agentAuth,
  agentFor,
  authHint,
  brokeringFor,
  expectedBlockedFor,
} from '../src/harness/agents.ts'
import { grokBuild, opencode } from '../src/harness.ts'
import { gatewayPart } from '../src/history/assemble.ts'
import { judgeCredentials, judgeRoute } from '../src/judge/index.ts'
import type { AgentHarnessDescriptor, GatewayName, HarnessDescriptor } from '../src/types.ts'

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

describe('the models reeval calls itself', () => {
  const scope = (...kinds: GatewayName[]) => ({ gateways: list(...kinds) })
  const UNSET = { gateways: list('direct') }
  const route = (model: string, pin: GatewayName | undefined, s: GatewayScope) =>
    resolveModelGateway(model, pin, s, 'judge model')

  test('without a list, a model takes only its own key: no gateway by default', () => {
    assert.equal(route('anthropic/claude-x', undefined, UNSET), 'direct')
    assert.throws(() => route('mistral/large', undefined, UNSET), /Add vercel\(\) to gateway\./)
    assert.deepEqual(judgeCredentials('anthropic/claude-x'), ['ANTHROPIC_API_KEY'])
    assert.throws(
      () => judgeRoute('anthropic/claude-x', { AI_GATEWAY_API_KEY: 'g' }),
      /AI_GATEWAY_API_KEY is set, but no gateway in the config uses it: add vercel\(\) to gateway/,
    )
  })

  test('on a list, a model takes the first gateway that serves it, and only its keys', () => {
    assert.equal(route('anthropic/claude-x', undefined, scope('vercel', 'direct')), 'vercel')
    assert.equal(route('anthropic/claude-x', undefined, scope('direct', 'vercel')), 'direct')
    assert.equal(route('mistral/large', undefined, scope('direct', 'vercel')), 'vercel')
    assert.deepEqual(judgeCredentials('anthropic/claude-x', 'direct'), ['ANTHROPIC_API_KEY'])
    assert.deepEqual(judgeCredentials('anthropic/claude-x', 'vercel'), [
      'AI_GATEWAY_API_KEY',
      'VERCEL_OIDC_TOKEN',
    ])
    assert.throws(
      () => judgeRoute('anthropic/claude-x', { AI_GATEWAY_API_KEY: 'g' }, 'judge model', 'direct'),
      /Set ANTHROPIC_API_KEY \(for direct\(\)\)/,
      "direct() doesn't reach for Vercel's key",
    )
    const both = { ANTHROPIC_API_KEY: 'a', AI_GATEWAY_API_KEY: 'g' }
    assert.deepEqual(judgeRoute('anthropic/claude-x', both, 'judge model', 'vercel'), {
      kind: 'gateway',
    })
    assert.throws(
      () => judgeRoute('anthropic/claude-x', { ANTHROPIC_API_KEY: 'a' }, 'judge model', 'vercel'),
      /Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN \(for vercel\(\)\)/,
    )
  })

  test('a model nothing in the list serves exits 2, naming the gateway that would', () => {
    assert.throws(() => route('mistral/large', undefined, scope('direct')), {
      name: 'UsageError',
      message:
        'judge model "mistral/large": no gateway in the list can serve it (direct: reeval calls only anthropic/*, google/*, openai/*, typesafe-ai/* models on their own keys). Add vercel() to gateway. There a judge must be a decision model, such as \'typesafe-ai/jev-1.14.0\'.',
    })
  })

  test('a pin skips the fallback, and must be listed and able to serve', () => {
    assert.equal(route('anthropic/claude-x', 'vercel', scope('direct', 'vercel')), 'vercel')
    assert.equal(route('anthropic/claude-x', 'direct', UNSET), 'direct')
    assert.throws(() => route('anthropic/claude-x', 'vercel', UNSET), {
      message:
        "judge model \"anthropic/claude-x\" pins gateway 'vercel', which isn't in the gateway list (direct). Add vercel() to gateway, or pin one that's there.",
    })
    assert.throws(
      () => route('mistral/large', 'direct', scope('direct', 'vercel')),
      /A pin never falls back/,
    )
    assert.equal(
      resolveModelGateway('anthropic/claude-x', { kind: 'vercel' }, scope('vercel'), 'judge model'),
      'vercel',
      'by its helper too',
    )
  })

  test('a model object or a fake calls through itself', () => {
    assert.equal(
      resolveModelGateway({ kind: 'fake-judge', score: 1 }, 'vercel', scope('direct'), 'j'),
      undefined,
    )
  })

  test("an expired Vercel project token fails the judge's call, naming the fix", () => {
    const token = jwt(Math.floor(Date.now() / 1000) - 60)
    assert.throws(
      () => judgeRoute('mistral/large', { VERCEL_OIDC_TOKEN: token }, 'judge model', 'vercel'),
      /^Error: judge model "mistral\/large": VERCEL_OIDC_TOKEN expired at .* Run vercel env pull/,
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
      agent.servedModel?.({
        host: 'ai-gateway.vercel.sh',
        responseModel: 'openai/gpt-5.6-luna',
        responseEffort: 'medium',
      } as never),
      'openai/gpt-5.6-luna[effort=medium]',
      'the effort, as on OpenAI',
    )
    assert.equal(
      agent.servedModel?.({ host: 'api.openai.com', responseModel: 'gpt-5' } as never),
      undefined,
    )
    assert.equal(agent.modelId?.('gpt-5.4-mini'), 'openai/gpt-5.4-mini')
    assert.equal(agent.modelId?.('openai/gpt-5.4-mini'), 'openai/gpt-5.4-mini')
  })

  test("fx's served model is only the response's; the model its call asked for is kept apart", () => {
    const agent = onVercel({ kind: 'fx', model: 'google/gemini-3.8-flash' } as HarnessDescriptor)
    const call = {
      host: 'ai-gateway.vercel.sh',
      method: 'POST',
      path: '/v4/ai/language-model',
      status: 200,
    }
    const asked = { headers: { 'ai-language-model-id': 'google/gemini-3.8-flash' } }
    assert.equal(agent.servedModel?.({ ...call, ...asked }), undefined, 'a header is no answer')
    assert.equal(
      agent.servedModel?.({ ...call, ...asked, responseModel: 'google/gemini-3.8-flash-001' }),
      'google/gemini-3.8-flash-001',
    )
    assert.equal(agent.askedModel?.({ ...call, ...asked }), 'google/gemini-3.8-flash')
    assert.equal(agent.askedModel?.(call), undefined)
    assert.equal(agent.askedModel?.({ ...call, ...asked, status: 401 }), undefined)
    assert.equal(agent.askedModel?.({ ...call, ...asked, status: 503 }), undefined)
    assert.equal(
      agent.askedModel?.({ ...call, path: '/coding-agent/v1/models', ...asked }),
      undefined,
    )
    assert.equal(agent.askedModel?.({ ...call, host: 'api.openai.com', ...asked }), undefined)
  })

  test('Goose takes Gemini ids as Google models on Vercel, and reads the served model', () => {
    const goose = onVercel({ kind: 'goose', model: 'gemini-3-flash' } as HarnessDescriptor)
    assert.equal(goose.credential, 'AI_GATEWAY_API_KEY')
    assert.deepEqual(
      goose.endpoints.map((e) => [e.method, e.path]),
      [
        [['POST'], { exact: '/v1/chat/completions' }],
        [['POST'], { exact: '/v1/responses' }],
        [['GET'], { exact: '/v1/models' }],
      ],
    )
    assert.deepEqual(
      goose.modelResponses?.map((e) => e.path),
      [{ exact: '/v1/chat/completions' }, { exact: '/v1/responses' }],
    )
    assert.deepEqual(goose.expectedBlocked?.hosts, ['models.dev'], "Goose's catalogue refresh")
    assert.deepEqual(goose.hosts, ['ai-gateway.vercel.sh'])
    assert.equal(goose.modelId?.('gemini-3-flash'), 'google/gemini-3-flash')
    assert.equal(goose.modelId?.('anthropic/claude-haiku-4.5'), 'anthropic/claude-haiku-4.5')
    assert.equal(
      goose.servedModel?.({
        host: 'ai-gateway.vercel.sh',
        responseModel: 'google/gemini-3-flash',
      } as never),
      'google/gemini-3-flash',
    )
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    assert.deepEqual(agentAuth(goose), { AI_GATEWAY_API_KEY: 'vck_test' })
  })

  test('Goose on Vercel gets its key and provider; pi off it stays on Gemini', async () => {
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    const descriptor = { kind: 'goose', model: 'gemini-3-flash', gateway: 'vercel' } as never
    const agent = agentFor(descriptor)
    const adapter = (await agent.adapter({
      auth: agentAuth(agent),
      descriptor,
      model: 'google/gemini-3-flash',
      plugins: [],
    })) as { harnessId: string }
    assert.equal(adapter.harnessId, 'goose')
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIza-test'
    const direct = agentFor({ kind: 'pi', model: 'gemini-3-flash' } as never)
    assert.equal(direct.credential, 'GOOGLE_GENERATIVE_AI_API_KEY')
    assert.ok(direct.endpoints.every((e) => e.host === 'generativelanguage.googleapis.com'))
  })

  test('OpenCode takes its own vercel provider, with the model as vercel/<id>', () => {
    const agent = onVercel({ kind: 'opencode', model: 'google/gemini-3-flash' } as never)
    assert.equal(agent.credential, 'AI_GATEWAY_API_KEY')
    assert.deepEqual(agent.hosts, ['ai-gateway.vercel.sh', 'mcp.exa.ai'])
    assert.deepEqual(
      agent.endpoints.map((e) => [e.host, e.path]),
      [
        ['ai-gateway.vercel.sh', { exact: '/v1/messages' }],
        ['ai-gateway.vercel.sh', { exact: '/v4/ai/messages' }],
      ],
    )
    assert.deepEqual(agent.modelResponses, agent.endpoints)
    assert.equal(agent.modelId?.('google/gemini-3-flash'), 'vercel/google/gemini-3-flash')
    assert.equal(
      agent.servedModel?.({
        method: 'POST',
        host: 'ai-gateway.vercel.sh',
        path: '/v1/messages',
        responseModel: 'google/gemini-3-flash',
      } as never),
      'google/gemini-3-flash',
    )
  })

  test('fx takes its own AI Gateway provider, and a bare id is OpenAI on Vercel', () => {
    const agent = onVercel({ kind: 'fx', model: 'gpt-4.1' } as never)
    assert.equal(agent.credential, 'AI_GATEWAY_API_KEY')
    assert.equal(agent.authAs, 'AI_GATEWAY_API_KEY')
    assert.deepEqual(agent.hosts, ['ai-gateway.vercel.sh'])
    assert.deepEqual(
      agent.endpoints.map((e) => [e.method, e.path]),
      [
        [['GET'], { regex: '^/coding-agent/v1/' }],
        [['POST'], { regex: '^/v\\d+/ai/language-model$' }],
      ],
    )
    assert.equal(agent.modelId?.('gpt-4.1'), 'openai/gpt-4.1')
    assert.equal(agent.modelId?.('google/gemini-3-flash'), 'google/gemini-3-flash')
  })

  test("Grok Build runs the model on Vercel's Chat Completions API, as xai/<id>", async () => {
    const descriptor = { kind: 'grok-build', model: 'grok-4.6', gateway: 'vercel' } as never
    const agent = agentFor(descriptor)
    assert.equal(agent.credential, 'AI_GATEWAY_API_KEY')
    assert.deepEqual(agent.hosts, ['ai-gateway.vercel.sh'])
    assert.deepEqual(
      agent.endpoints.map((e) => [e.host, e.method, e.path]),
      [['ai-gateway.vercel.sh', ['POST'], { exact: '/v1/chat/completions' }]],
    )
    assert.deepEqual(agent.modelResponses, agent.endpoints)
    assert.equal(agent.modelId?.('grok-4.6'), 'xai/grok-4.6')
    assert.equal(agent.modelId?.('openai/gpt-5'), 'openai/gpt-5')
    assert.deepEqual(expectedBlockedFor(descriptor, false)?.hosts, ['vercel.com'])
    assert.equal(
      expectedBlockedFor({ kind: 'grok-build', model: 'grok-4.6' } as never, false),
      undefined,
      'only on Vercel',
    )
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    const adapter = (await agent.adapter({
      auth: agentAuth(agent),
      descriptor,
      model: 'xai/grok-4.6',
      plugins: [],
    })) as { harnessId: string }
    assert.equal(adapter.harnessId, 'grok-build')
  })

  test("a gateway id isn't fx on direct: it falls through to Vercel, or names it", () => {
    const fx = { kind: 'fx', model: 'google/gemini-3-flash' } as HarnessDescriptor
    const why =
      'fx runs a gateway id such as "google/gemini-3-flash" only through Vercel AI Gateway'
    assert.deepEqual(resolve(list('direct', 'vercel'), fx), {
      name: 'vercel',
      skipped: [{ gateway: 'direct', why }],
    })
    assert.throws(() => resolve(list('direct'), fx), {
      message: `evaluate("e") on fx:gemini-3-flash: no gateway in the list can serve it (direct: ${why}). Add vercel() to gateway.`,
    })
    const bare = { kind: 'fx', model: 'gpt-4.1' } as HarnessDescriptor
    assert.deepEqual(resolve(list('direct'), bare), { name: 'direct', skipped: [] })
  })

  test("Grok Build takes no gateway id on any gateway: it's refused as the eval loads", () => {
    assert.throws(() => grokBuild({ model: 'openai/gpt-5' }), /needs an xAI model id/)
  })

  test("OpenCode's provider table gates direct() only", () => {
    const oc = { kind: 'opencode', model: 'mistral-x/large' } as HarnessDescriptor
    assert.deepEqual(resolve(list('direct', 'vercel'), oc).name, 'vercel')
    assert.throws(
      () => resolve(list('direct'), oc),
      /no gateway in the list can serve it \(direct:/,
    )
  })

  test('effort with a harness whose effort path on Vercel is unchecked is refused there', () => {
    for (const [kind, model] of [
      ['goose', 'gemini-3-flash'],
      ['opencode', 'anthropic/claude-haiku-4-5'],
    ] as const) {
      const h = { kind, model, effort: 'high' } as HarnessDescriptor
      assert.throws(
        () => resolve(list('vercel'), h),
        /doesn't send .*'s effort \("high"\) to .* through Vercel AI Gateway yet/,
      )
      assert.equal(resolve(list('vercel', 'direct'), h).name, 'direct', 'it falls through')
      assert.equal(resolve(list('vercel'), { ...h, effort: undefined }).name, 'vercel')
    }
    for (const h of [
      claude,
      codex,
      { kind: 'opencode', model: 'google/gemini-3.8-flash' },
      { kind: 'pi', model: 'gemini-3.8-flash' },
      { kind: 'grok-build', model: 'grok-4.6' },
    ]) {
      const high = { ...h, effort: 'high' } as HarnessDescriptor
      assert.equal(resolve(list('vercel'), high).name, 'vercel', high.kind)
    }
  })

  test("a brokered 401 gets the refused-key hint, whatever the CLI's message", () => {
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    for (const [kind, model, message] of [
      ['goose', 'gemini-3.8-flash', 'ACP prompt update stream failed: Authentication required'],
      ['grok-build', 'grok-4.6', 'ACP prompt update stream failed: Internal error'],
    ] as const) {
      const agent = onVercel({ kind, model } as HarnessDescriptor)
      assert.match(authHint(agent, message, true) ?? '', /rejected AI_GATEWAY_API_KEY/, kind)
      assert.equal(authHint(agent, 'Internal error'), undefined, `${kind}: no 401, no hint`)
    }
  })

  test('a turn whose every brokered call got an HTTP error fails, naming the statuses', () => {
    assert.equal(everyCallFailed('fx', []), undefined, 'nothing brokered says nothing')
    assert.equal(everyCallFailed('fx', [401, 200]), undefined, 'one call succeeded')
    assert.equal(
      everyCallFailed('fx', [401, 401, 503]),
      'every fx model call in the turn failed (HTTP 401, 503)',
    )
  })

  test('pi on Vercel: its own provider on Chat Completions, the model as google/<id>', () => {
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    const agent = onVercel({ kind: 'pi', model: 'gemini-3.8-flash' } as never)
    assert.equal(agent.credential, 'AI_GATEWAY_API_KEY')
    assert.deepEqual(agent.hosts, ['ai-gateway.vercel.sh'])
    assert.deepEqual(
      agent.endpoints.map((e) => [e.host, e.path, e.method]),
      [['ai-gateway.vercel.sh', { exact: '/v1/chat/completions' }, ['POST']]],
    )
    assert.deepEqual(agent.modelResponses, agent.endpoints)
    assert.equal(agent.modelId?.('gemini-3.8-flash'), 'google/gemini-3.8-flash')
  })

  test("OpenCode on Vercel: a Gemini model's effort is its thinking level under providerOptions", () => {
    const thinking = { thinkingConfig: { thinkingLevel: 'high' } }
    const gemini = openCodeConfig({ model: 'vercel/google/gemini-3-flash', effort: 'high' })
    assert.deepEqual(gemini.providers?.vercel?.models?.['google/gemini-3-flash']?.body, {
      providerOptions: { google: thinking, vertex: thinking },
    })
    const claude = openCodeConfig({ model: 'vercel/anthropic/claude-sonnet-4.5', effort: 'high' })
    assert.equal(claude.providers?.vercel?.models, undefined)
  })

  test("the egress gateway swaps Vercel's key in only on Vercel's model paths", () => {
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    const brokering = brokeringFor({ ...claude, gateway: 'vercel' } as HarnessDescriptor)
    assert.equal(brokering?.credential, 'AI_GATEWAY_API_KEY')
    const on = (method: string, host: string, path: string) =>
      onEndpoint(brokering?.endpoints ?? [], { method, host, path, headers: {} })
    assert.equal(on('POST', 'ai-gateway.vercel.sh', '/v1/messages?beta=true'), true)
    assert.equal(on('POST', 'ai-gateway.vercel.sh', '/v1/messages/count_tokens'), true)
    assert.equal(on('GET', 'ai-gateway.vercel.sh', '/api/claude_code/settings'), false)
    assert.equal(on('GET', 'ai-gateway.vercel.sh', '/v1/messages'), false)
    assert.equal(on('GET', 'ai-gateway.vercel.sh', '/v1/models'), false)
    assert.equal(on('POST', 'api.anthropic.com', '/v1/messages'), false)
    const codexBrokering = brokeringFor({ ...codex, gateway: 'vercel' } as HarnessDescriptor)
    const onCodex = (host: string, path: string) =>
      onEndpoint(codexBrokering?.endpoints ?? [], { method: 'POST', host, path, headers: {} })
    assert.equal(onCodex('ai-gateway.vercel.sh', '/v1/responses'), true)
    assert.equal(onCodex('api.openai.com', '/v1/responses'), false)
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
    assert.deepEqual(
      VERCEL_GATEWAY.routes['claude-code']?.(process.env).authAs,
      'AI_GATEWAY_API_KEY',
    )
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

describe('OpenRouter routes', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })
  const onOpenRouter = (h: HarnessDescriptor) =>
    agentFor({ ...h, gateway: 'openrouter' } as AgentHarnessDescriptor)
  const call = (path: string, extra: object = {}) =>
    ({ method: 'POST', host: 'openrouter.ai', path, status: 200, ...extra }) as never

  test('it serves Claude Code, Codex, Goose, OpenCode and Grok Build, and says why not the rest', () => {
    const served = ['claude-code', 'codex', 'goose', 'opencode', 'grok-build']
    assert.deepEqual(Object.keys(OPENROUTER_GATEWAY.routes).sort(), [...served].sort())
    for (const [kind, why] of [
      ['cursor', /Cursor's agent only calls Cursor's own API/],
      ['antigravity', /OpenRouter has no Gemini API/],
      ['fx', /fx reaches models only on Vercel AI Gateway or OpenAI's API/],
      ['pi', /pi reaches a Gemini model on OpenRouter only through Chat Completions/],
    ] as const) {
      const h = { kind, model: kind === 'fx' ? 'gpt-4.1' : 'm' } as HarnessDescriptor
      assert.throws(() => resolve(list('openrouter'), h), why, kind)
      assert.equal(resolve(list('openrouter', 'direct'), h).name, 'direct', `${kind} falls through`)
    }
  })

  test("Claude Code calls OpenRouter's Messages API on a Bearer token, with dotted Anthropic ids", () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    const agent = onOpenRouter(claude)
    assert.equal(agent.credential, 'OPENROUTER_API_KEY')
    assert.deepEqual(agentAuth(agent), {
      ANTHROPIC_AUTH_TOKEN: 'sk-or-test',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    })
    assert.deepEqual(agent.hosts, ['openrouter.ai'])
    assert.deepEqual(
      agent.endpoints.map((e) => [e.host, e.method, e.path]),
      [
        ['openrouter.ai', ['POST'], { exact: '/api/v1/messages' }],
        ['openrouter.ai', ['POST'], { exact: '/api/v1/messages/count_tokens' }],
      ],
    )
    assert.equal(agent.modelId?.('claude-haiku-4-5'), 'anthropic/claude-haiku-4.5')
    assert.equal(anthropicOnOpenRouter('claude-sonnet-4-5'), 'anthropic/claude-sonnet-4.5')
    assert.equal(anthropicOnOpenRouter('claude-opus-4'), 'anthropic/claude-opus-4')
    assert.equal(anthropicOnOpenRouter('anthropic/claude-x'), 'anthropic/claude-x')
  })

  test("Codex, Goose and Grok Build name their provider in the id, on OpenRouter's API paths", () => {
    for (const [h, path, id] of [
      [codex, '/api/v1/responses', 'openai/gpt-5.4-mini'],
      [
        { kind: 'goose', model: 'gemini-3-flash' },
        '/api/v1/chat/completions',
        'google/gemini-3-flash',
      ],
      [{ kind: 'grok-build', model: 'grok-4.6' }, '/api/v1/chat/completions', 'x-ai/grok-4.6'],
    ] as const) {
      const agent = onOpenRouter(h as HarnessDescriptor)
      assert.equal(agent.credential, 'OPENROUTER_API_KEY', h.kind)
      assert.ok(
        agent.endpoints.every((e) => e.host === 'openrouter.ai'),
        h.kind,
      )
      assert.ok(
        agent.modelResponses?.some((e) => 'exact' in e.path && e.path.exact === path),
        h.kind,
      )
      assert.equal(agent.modelId?.(h.model), id, h.kind)
      assert.equal(agent.modelId?.('anthropic/claude-x'), 'anthropic/claude-x', h.kind)
    }
  })

  test('OpenCode takes its own openrouter provider, with the model as openrouter/<id>', () => {
    const agent = onOpenRouter({ kind: 'opencode', model: 'google/gemini-3-flash' } as never)
    assert.equal(agent.credential, 'OPENROUTER_API_KEY')
    assert.deepEqual(agent.hosts, ['openrouter.ai', 'mcp.exa.ai'])
    assert.equal(agent.modelId?.('google/gemini-3-flash'), 'openrouter/google/gemini-3-flash')
    assert.throws(
      () => opencode({ model: 'openrouter/google/gemini-3-flash' }),
      /an openrouter\/… id would bypass the config's gateway list: write the model as 'google\/gemini-3-flash' and add openrouter\(\) to gateway/,
    )
  })

  test("the adapters pick OpenRouter's provider from the key they're given", async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    for (const [kind, model] of [
      ['goose', 'google/gemini-3-flash'],
      ['codex', 'openai/gpt-5.4-mini'],
      ['grok-build', 'x-ai/grok-4.6'],
    ] as const) {
      const descriptor = { kind, model, gateway: 'openrouter' } as never
      const agent = agentFor(descriptor)
      const adapter = (await agent.adapter({
        auth: agentAuth(agent),
        descriptor,
        model,
        plugins: [],
      })) as { harnessId: string }
      assert.equal(adapter.harnessId, kind)
    }
  })

  test("every call records the served model and OpenRouter's upstream provider and cost", () => {
    const agent = onOpenRouter(codex)
    const response = call('/api/v1/responses', {
      responseModel: 'openai/gpt-5.4-mini',
      responseEffort: 'low',
      responseProvider: 'OpenAI',
      responseCost: 0.0004,
    })
    assert.equal(agent.servedModel?.(response), 'openai/gpt-5.4-mini[effort=low]')
    assert.deepEqual(agent.upstream?.(response), { provider: 'OpenAI', costUsd: 0.0004 })
    assert.equal(
      upstreamOnOpenRouter({ ...(response as object), host: 'api.openai.com' } as never),
      undefined,
    )
    assert.equal(upstreamOnOpenRouter(call('/api/v1/responses')), undefined, 'no provider named')
    const brokering = brokeringFor({ ...codex, gateway: 'openrouter' } as HarnessDescriptor)
    assert.equal(brokering?.upstream, upstreamOnOpenRouter)
    assert.equal(brokeringFor(codex)?.upstream, undefined, 'off OpenRouter, nothing names one')
  })

  test("effort on OpenRouter: Claude Code's is refused, and the others' on a model no run checked", () => {
    for (const h of [
      { ...claude, effort: 'high' },
      { kind: 'goose', model: 'llama-4', effort: 'high' },
      { kind: 'opencode', model: 'anthropic/claude-haiku-4-5', effort: 'high' },
    ] as HarnessDescriptor[]) {
      assert.throws(
        () => resolve(list('openrouter'), h),
        /doesn't send .*'s effort \("high"\) to .* through OpenRouter yet/,
      )
    }
    for (const h of [
      codex,
      { kind: 'goose', model: 'gemini-3.8-flash' },
      { kind: 'opencode', model: 'google/gemini-3.8-flash' },
      { kind: 'grok-build', model: 'grok-4.6' },
    ]) {
      const high = { ...h, effort: 'high' } as HarnessDescriptor
      assert.equal(resolve(list('openrouter'), high).name, 'openrouter', high.kind)
    }
  })

  test("reeval's own models take OpenRouter's key, its package, and fallbacks off by default", () => {
    assert.equal(
      resolveModelGateway(
        'mistral/large',
        undefined,
        { gateways: list('openrouter') },
        'judge model',
      ),
      'openrouter',
    )
    assert.deepEqual(judgeCredentials('anthropic/claude-x', 'openrouter'), ['OPENROUTER_API_KEY'])
    assert.deepEqual(
      judgeRoute('typesafe/jev-1.14', { OPENROUTER_API_KEY: 'k' }, 'judge model', 'openrouter'),
      { kind: 'openrouter' },
    )
    assert.throws(
      () =>
        judgeRoute('typesafe/jev-1.14', { ANTHROPIC_API_KEY: 'a' }, 'judge model', 'openrouter'),
      /Set OPENROUTER_API_KEY \(for openrouter\(\)\)/,
    )
    assert.throws(
      () => judgeRoute('anthropic/claude-x', { OPENROUTER_API_KEY: 'k' }),
      /OPENROUTER_API_KEY is set, but no gateway in the config uses it: add openrouter\(\) to gateway/,
    )
    assert.equal(openRouterFallbacks([{ kind: 'openrouter' }]), false)
    assert.equal(openRouterFallbacks([{ kind: 'openrouter', fallbacks: false }]), false)
    assert.equal(
      openRouterFallbacks([{ kind: 'direct' }, { kind: 'openrouter', fallbacks: true }]),
      true,
    )
  })

  test("a host call's upstream and cost come from OpenRouter's provider metadata", () => {
    assert.deepEqual(
      openRouterBilling({ openrouter: { provider: 'Typesafe', usage: { cost: 0.00012 } } }),
      { upstream: 'Typesafe', costUsd: 0.00012 },
    )
    assert.deepEqual(openRouterBilling({ openrouter: { provider: '' } }), {})
    assert.deepEqual(openRouterBilling(undefined), {})
  })
})

describe('Vertex AI routes', () => {
  const settings = vertexSettings({ project: 'reeval-512515', location: 'us-east5' }, {})
  const onVertex = (h: HarnessDescriptor) =>
    agentFor({ ...h, gateway: 'vertex' } as AgentHarnessDescriptor, settings)
  const STREAM = '/v1/projects/reeval-512515/locations/us-east5/publishers/anthropic/models'

  test('vertex() takes its project from the entry, else GOOGLE_CLOUD_PROJECT, else refuses', () => {
    assert.deepEqual(vertexSettings({}, { GOOGLE_CLOUD_PROJECT: 'p' }), {
      project: 'p',
      location: 'global',
      regions: {},
    })
    assert.equal(vertexSettings({ project: 'q' }, { GOOGLE_CLOUD_PROJECT: 'p' }).project, 'q')
    assert.throws(() => vertexSettings({}, {}), /vertex\(\) has no project/)
    assert.equal(vertexHost('global'), 'aiplatform.googleapis.com')
    assert.equal(vertexHost('us-east5'), 'us-east5-aiplatform.googleapis.com')
    const regional = vertexSettings({ project: 'p', regions: { anthropic: 'europe-west1' } }, {})
    assert.equal(vertexRegion(regional, 'anthropic'), 'europe-west1')
    assert.equal(vertexRegion(regional, 'google'), 'global')
  })

  test('Claude Code on Vertex is pointed at the project and brokered only on its model calls', () => {
    const agent = onVertex({ kind: 'claude-code', model: 'claude-sonnet-4-5@20250929' } as never)
    const host = 'us-east5-aiplatform.googleapis.com'
    assert.equal(agent.credential, 'Google Cloud credentials')
    assert.deepEqual(agent.hosts, [host])
    assert.deepEqual(agent.routeEnv, {
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'reeval-512515',
      CLOUD_ML_REGION: 'us-east5',
    })
    assert.deepEqual(agentAuth(agent, {}), {}, 'no key from the environment')
    assert.equal(agent.modelId?.('anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5')
    assert.equal(agent.modelId?.('claude-haiku-4-5-20251001'), 'claude-haiku-4-5@20251001')
    assert.equal(
      agent.modelId?.('anthropic/claude-haiku-4-5-20251001'),
      'claude-haiku-4-5@20251001',
    )
    assert.equal(agent.modelId?.('claude-haiku-4-5@20251001'), 'claude-haiku-4-5@20251001')
    const on = (method: string, h: string, path: string) =>
      onEndpoint(agent.endpoints, { method, host: h, path, headers: {} })
    assert.ok(on('POST', host, `${STREAM}/claude-sonnet-4-5@20250929:streamRawPredict`))
    assert.ok(on('POST', host, `${STREAM}/claude-sonnet-4-5:rawPredict?alt=sse`))
    assert.ok(!on('GET', host, `${STREAM}/claude-sonnet-4-5:streamRawPredict`))
    assert.ok(!on('POST', 'aiplatform.googleapis.com', `${STREAM}/m:streamRawPredict`))
    assert.ok(
      !on('POST', host, `${STREAM.replace('reeval-512515', 'other')}/m:streamRawPredict`),
      "another project's calls get no token",
    )
    assert.ok(!on('POST', host, `${STREAM.replace('anthropic', 'google')}/m:streamRawPredict`))
    assert.equal(
      agent.servedModel?.({
        host,
        path: `${STREAM}/claude-sonnet-4-5@1:streamRawPredict`,
      } as never),
      'claude-sonnet-4-5@1',
    )
    assert.equal(
      agent.servedModel?.({ host, path: `${STREAM}/count-tokens:rawPredict` } as never),
      undefined,
    )
    const rules = agent.token?.transformations('ya29.t') ?? []
    assert.deepEqual(
      rules.map((r) => r.match),
      agent.endpoints,
    )
    assert.ok(rules.every((r) => r.transform.headers?.authorization === 'Bearer ya29.t'))
    assert.equal(brokeringFor(pinned(claude, 'vertex'), settings)?.credential, agent.credential)
  })

  test('the Gemini CLIs on Vertex read a made-up service account and get the token on their model calls', async () => {
    const global = vertexSettings({ project: 'reeval-512515' }, {})
    const onGlobal = (h: HarnessDescriptor) =>
      agentFor({ ...h, gateway: 'vertex' } as AgentHarnessDescriptor, global)
    const host = 'aiplatform.googleapis.com'
    const google = (v: string) =>
      `/${v}/projects/reeval-512515/locations/global/publishers/google/models`
    for (const kind of ['antigravity', 'goose', 'pi', 'opencode'] as const) {
      const agent = onGlobal({ kind, model: 'gemini-3.8-flash' } as never)
      assert.equal(agent.credential, 'Google Cloud credentials', kind)
      assert.deepEqual(agentAuth(agent, {}), {}, `${kind}: no key from the environment`)
      assert.ok(agent.hosts?.includes(host) && agent.hosts.includes('oauth2.googleapis.com'), kind)
      const on = (method: string, h: string, path: string) =>
        onEndpoint(agent.endpoints, { method, host: h, path, headers: {} })
      assert.ok(on('POST', host, `${google('v1')}/gemini-3.8-flash:streamGenerateContent?alt=sse`))
      assert.ok(on('POST', host, `${google('v1beta1')}/gemini-3.8-flash:generateContent`))
      assert.ok(!on('POST', host, `${google('v1beta')}/gemini-3.8-flash:generateContent`))
      assert.ok(
        !on(
          'POST',
          host,
          `${google('v1')}/claude-x@default:rawPredict`.replace('google', 'anthropic'),
        ),
        `${kind}: no token on another publisher's calls`,
      )
      assert.equal(
        agent.servedModel?.({
          host,
          path: `${google('v1')}/gemini-3.8-flash:streamGenerateContent`,
        } as never),
        'gemini-3.8-flash',
      )
      const adc = JSON.parse(agent.adc?.content ?? '{}')
      assert.equal(adc.type, 'service_account', kind)
      assert.equal(adc.project_id, 'reeval-512515', kind)
      assert.equal(adc.token_uri, 'https://oauth2.googleapis.com/token', kind)
      assert.match(adc.private_key, /^-----BEGIN PRIVATE KEY-----/)
      assert.deepEqual(
        { project: agent.adc?.project, location: agent.adc?.location },
        { project: 'reeval-512515', location: 'global' },
      )
      const token = agent.localResponses?.find((r) => r.match.host === 'oauth2.googleapis.com')
      assert.equal(JSON.parse(token?.body ?? '{}').access_token, SANDBOX_ACCESS_TOKEN, kind)
      assert.deepEqual(
        brokeringFor({ kind, model: 'gemini-3.8-flash', gateway: 'vertex' } as never, global)
          ?.localResponses,
        agent.localResponses,
      )
      const vertex = { project: 'reeval-512515', location: 'global', credentialsFile: '/r/a.json' }
      const adapter = await agent.adapter({
        auth: agentAuth(agent, {}),
        descriptor: { kind, model: 'gemini-3.8-flash' } as never,
        model: agent.modelId?.('gemini-3.8-flash') ?? 'gemini-3.8-flash',
        plugins: [],
        vertex,
      })
      assert.equal((adapter as { harnessId: string }).harnessId, kind)
    }
    assert.equal(
      onGlobal({ kind: 'pi', model: 'm' } as never).modelId?.('google/gemini-3.8-flash'),
      'gemini-3.8-flash',
    )
    const opencode = onGlobal({ kind: 'opencode', model: 'm' } as never)
    assert.equal(opencode.modelId?.('google/gemini-3.8-flash'), 'google-vertex/gemini-3.8-flash')
    assert.equal(opencode.modelId?.('gemini-3.8-flash'), 'google-vertex/gemini-3.8-flash')
    const agy = onGlobal({ kind: 'antigravity', model: 'm' } as never)
    assert.ok(agy.localResponses?.some((r) => r.match.host === 'www.googleapis.com'))
  })

  test('the gateway serves Claude Code on Vertex, not the agents it has no route for', () => {
    assert.deepEqual(resolve(list('vertex', 'direct'), claude), { name: 'vertex', skipped: [] })
    assert.equal(resolve(list('vertex', 'direct'), codex).name, 'direct')
    assert.throws(
      () => agentFor({ ...codex, gateway: 'vertex' } as AgentHarnessDescriptor, settings),
      /doesn't run Codex on Vertex AI/,
    )
    assert.throws(
      () => agentFor({ ...claude, gateway: 'vertex' } as AgentHarnessDescriptor),
      /no vertex\(\) settings/,
    )
    const onVertex = { ...claude, gateway: 'vertex' } as AgentHarnessDescriptor
    assert.doesNotThrow(() => expectedBlockedFor(onVertex, false, settings))
    assert.throws(() => expectedBlockedFor(onVertex, false), /no vertex\(\) settings/)
  })

  test("reeval's own models on Vertex: google/* and anthropic/*, with the host's token", async () => {
    const regional = vertexSettings(
      { project: 'reeval-512515', regions: { anthropic: 'us-east5' } },
      {},
    )
    assert.equal(vertexModelRefusal('google/gemini-3.8-flash'), undefined)
    assert.equal(vertexModelRefusal('anthropic/claude-haiku-4-5'), undefined)
    assert.match(vertexModelRefusal('openai/gpt-5.4') ?? '', /only google\/\* and anthropic\/\*/)
    assert.equal(
      resolveModelGateway(
        'anthropic/m',
        undefined,
        { gateways: list('vertex') } as GatewayScope,
        'judge model',
      ),
      'vertex',
    )
    assert.deepEqual(judgeRoute('google/m', {}, 'judge model', 'vertex'), { kind: 'vertex' })
    assert.deepEqual(judgeCredentials('google/m', 'vertex'), [])
    await assert.rejects(
      vertexLanguageModel('openai/gpt-5.4', regional, async () => ({ token: 't', expiresAt: 0 })),
      /only google\/\* and anthropic\/\*/,
    )

    const seen: { url: string; authorization: string | null }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      throw new Error('offline')
    }) as typeof fetch
    try {
      const source = async () => ({ token: 'ya29.host', expiresAt: Date.now() + 3_600_000 })
      for (const id of ['anthropic/claude-haiku-4-5-20251001', 'google/gemini-3.8-flash']) {
        const model = await vertexDecisionModel(id, regional, source)
        assert.equal(model.provider, 'google-vertex.decision')
        const inner = await vertexLanguageModel(id, regional, source)
        await inner
          .doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
          .catch(() => undefined)
      }
    } finally {
      globalThis.fetch = realFetch
    }
    assert.deepEqual(
      seen.map((s) => [new URL(s.url).host, new URL(s.url).pathname, s.authorization]),
      [
        [
          'us-east5-aiplatform.googleapis.com',
          '/v1/projects/reeval-512515/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict',
          'Bearer ya29.host',
        ],
        [
          'aiplatform.googleapis.com',
          '/v1beta1/projects/reeval-512515/locations/global/publishers/google/models/gemini-3.8-flash:generateContent',
          'Bearer ya29.host',
        ],
      ],
    )
  })
})

describe('brokered tokens', () => {
  const clock = () => {
    let t = 0
    const timers: { at: number; run: () => void; cancelled: boolean }[] = []
    return {
      now: () => t,
      schedule: (run: () => void, ms: number) => {
        const timer = { at: t + ms, run, cancelled: false }
        timers.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
      async advance(ms: number) {
        t += ms
        for (const timer of timers.splice(0)) {
          if (timer.cancelled) continue
          if (timer.at <= t) timer.run()
          else timers.push(timer)
        }
        await new Promise((r) => setImmediate(r))
      },
      pending: () => timers.filter((x) => !x.cancelled).map((x) => x.at),
    }
  }
  const MIN = 60_000

  test('a cached source shares one mint and one token until near its expiry', async () => {
    let t = 0
    let mints = 0
    const source = cachedTokenSource(
      async () => {
        mints += 1
        return { token: `t${mints}`, expiresAt: t + 60 * MIN }
      },
      () => t,
    )
    const [a, b] = await Promise.all([source(), source()])
    assert.equal(mints, 1)
    assert.equal(a, b)
    t = 54 * MIN
    assert.equal((await source()).token, 't1')
    t = 56 * MIN
    assert.equal((await source()).token, 't2', 'within five minutes of expiry')
  })

  test('the session gets fresh rules before each token expires, and none after stop', async () => {
    const c = clock()
    let mints = 0
    const added: string[] = []
    const brokered = {
      source: async () => {
        mints += 1
        return { token: `t${mints}`, expiresAt: c.now() + 60 * MIN }
      },
      transformations: (token: string) => [
        { match: { host: 'h' }, transform: { headers: { authorization: token } } },
      ],
    }
    const session = {
      addRequestTransformations: async (rules: readonly { transform: unknown }[]) => {
        added.push(...rules.map((r) => JSON.stringify(r.transform)))
      },
    }
    const stop = await brokerToken(brokered, session as never, c)
    assert.equal(added.length, 1)
    assert.deepEqual(c.pending(), [55 * MIN])
    await c.advance(55 * MIN)
    assert.equal(added.length, 2)
    assert.match(added[1] ?? '', /t2/)
    assert.deepEqual(c.pending(), [110 * MIN])
    stop()
    await c.advance(60 * MIN)
    assert.equal(added.length, 2)
    assert.deepEqual(c.pending(), [])
  })

  test('a failed refresh is retried while the current token works; a failed first mint throws', async () => {
    const c = clock()
    let fail = false
    const errors: unknown[] = []
    const brokered = {
      source: async () => {
        if (fail) throw new Error('offline')
        return { token: 't', expiresAt: c.now() + 6 * MIN }
      },
      transformations: () => [],
    }
    const session = { addRequestTransformations: async () => {} }
    const stop = await brokerToken(brokered, session, {
      ...c,
      onError: (e) => errors.push(e),
    })
    assert.deepEqual(c.pending(), [MIN], 'never sooner than the 30 s floor, here a minute')
    fail = true
    await c.advance(MIN)
    assert.equal(errors.length, 1)
    assert.deepEqual(c.pending(), [MIN + RETRY_MS])
    fail = false
    await c.advance(RETRY_MS)
    assert.deepEqual(c.pending(), [MIN + RETRY_MS + MIN])
    stop()
    fail = true
    await assert.rejects(brokerToken(brokered, session, c), /offline/)
    await assert.rejects(brokerToken(brokered, {}, c), /can't add request transformations/)
  })
})
