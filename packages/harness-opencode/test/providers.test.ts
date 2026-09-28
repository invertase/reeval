import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OPENCODE_CLI_VERSION } from '../src/opencode-harness.ts'
import { PROBED_VERSION } from '../src/opencode-provider-table.ts'
import {
  OPENCODE_PROVIDERS,
  openCodeProvider,
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  providerTransformations,
  REFUSED_OPENCODE_PROVIDERS,
  resolveOpenCodeProvider,
  splitModel,
} from '../src/opencode-providers.ts'

test('the table was probed on the pinned OpenCode', () => {
  assert.equal(PROBED_VERSION, OPENCODE_CLI_VERSION)
})

test('each provider is supported or refused, once, and the table is well formed', () => {
  const ids = [...OPENCODE_PROVIDERS, ...REFUSED_OPENCODE_PROVIDERS].map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const p of OPENCODE_PROVIDERS) {
    assert.match(p.env, /^\w+$/, p.id)
    assert.ok(p.headers.length > 0, `${p.id} has a header`)
    for (const h of p.headers) {
      assert.ok(['authorization', 'x-api-key', 'x-goog-api-key'].includes(h.name), h.name)
      assert.equal(h.scheme, h.name === 'authorization' ? 'bearer' : 'raw', `${p.id} ${h.name}`)
    }
    assert.ok(p.endpoints.length > 0, `${p.id} has an endpoint`)
    for (const e of p.endpoints) {
      // A fixed public host: no loopback, IP address or unfilled ${VARIABLE}.
      assert.match(e.host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${p.id} ${e.host}`)
      assert.doesNotMatch(e.host, /^(\d+\.){3}\d+$|localhost/, `${p.id} ${e.host}`)
      if ('exact' in e.path) assert.match(e.path.exact, /^\//, `${p.id}`)
      else assert.equal(new RegExp(`${e.path.regex}|`).exec('')?.length, 2, `${p.id}: one group`)
    }
  }
  for (const p of REFUSED_OPENCODE_PROVIDERS) assert.ok(p.why.length > 20, p.id)
})

test("the main providers' keys go where OpenCode 2.0.18 was seen to send them", () => {
  const where = (id: string) => {
    const p = openCodeProvider(`${id}/m`)
    return {
      env: p.env,
      headers: p.headers.map((h) => `${h.name}:${h.scheme}`),
      posts: p.endpoints
        .filter((e) => e.method.includes('POST'))
        .map((e) => `${e.host}${'exact' in e.path ? e.path.exact : e.path.regex}`),
    }
  }
  const bearer = ['authorization:bearer']
  const expected: Record<string, ReturnType<typeof where>> = {
    google: {
      env: 'GOOGLE_GENERATIVE_AI_API_KEY',
      headers: ['x-goog-api-key:raw'],
      posts: ['generativelanguage.googleapis.com^/v1beta/models/([^/]+):streamGenerateContent$'],
    },
    anthropic: {
      env: 'ANTHROPIC_API_KEY',
      headers: ['x-api-key:raw'],
      posts: ['api.anthropic.com/v1/messages'],
    },
    openai: { env: 'OPENAI_API_KEY', headers: bearer, posts: ['api.openai.com/v1/responses'] },
    openrouter: {
      env: 'OPENROUTER_API_KEY',
      headers: bearer,
      posts: ['openrouter.ai/api/v1/chat/completions'],
    },
    groq: {
      env: 'GROQ_API_KEY',
      headers: bearer,
      posts: ['api.groq.com/openai/v1/chat/completions'],
    },
    mistral: {
      env: 'MISTRAL_API_KEY',
      headers: bearer,
      posts: ['api.mistral.ai/v1/chat/completions'],
    },
    xai: { env: 'XAI_API_KEY', headers: bearer, posts: ['api.x.ai/v1/responses'] },
    deepseek: {
      env: 'DEEPSEEK_API_KEY',
      headers: bearer,
      posts: ['api.deepseek.com/chat/completions'],
    },
    togetherai: {
      env: 'TOGETHER_API_KEY',
      headers: bearer,
      posts: ['api.together.xyz/v1/chat/completions'],
    },
    'fireworks-ai': {
      env: 'FIREWORKS_API_KEY',
      headers: bearer,
      posts: ['api.fireworks.ai/inference/v1/chat/completions'],
    },
    vercel: {
      env: 'AI_GATEWAY_API_KEY',
      headers: bearer,
      posts: ['ai-gateway.vercel.sh/v3/ai/language-model'],
    },
  }
  for (const [id, want] of Object.entries(expected)) assert.deepEqual(where(id), want, id)
})

test('a provider whose models use several APIs has each API’s header', () => {
  const zen = openCodeProvider('opencode/gpt-5.4')
  assert.deepEqual(zen.headers.map((h) => h.name).sort(), [
    'authorization',
    'x-api-key',
    'x-goog-api-key',
  ])
  assert.deepEqual(providerHosts(zen), ['opencode.ai'])
})

test('a model id is <provider>/<model>; the provider is before the first /', () => {
  assert.deepEqual(splitModel('openrouter/anthropic/claude-haiku-4.5'), {
    provider: 'openrouter',
    model: 'anthropic/claude-haiku-4.5',
  })
  for (const bare of ['gemini-3.8-flash', '/m', 'google/', '']) {
    assert.equal(splitModel(bare), undefined, bare)
  }
})

test('a model that can’t run says why: no provider, an unknown one, or one ES refuses', () => {
  const error = (model: string) => {
    const r = resolveOpenCodeProvider(model)
    return 'error' in r ? r.error : ''
  }
  assert.match(
    error('gemini-3.8-flash'),
    /an OpenCode model id names its provider, <provider>\/<model>, such as 'google\/gemini-3\.8-flash'.*\(got "gemini-3\.8-flash"\)/,
  )
  assert.match(error('nope/m'), /OpenCode has no provider "nope" \(in "nope\/m"\)/)
  const refused: Record<string, RegExp> = {
    'amazon-bedrock': /Amazon Bedrock \(amazon-bedrock\): its AWS credentials sign each request/,
    'google-vertex': /Vertex \(google-vertex\): it takes a service account/,
    'github-copilot': /GitHub Copilot \(github-copilot\): it runs on a GitHub Copilot subscription/,
    azure: /Azure \(azure\): its API host is per account \(AZURE_RESOURCE_NAME\)/,
    lmstudio: /LMStudio \(lmstudio\): it runs on your machine/,
    perplexity: /Perplexity \(perplexity\): none of its models can call tools/,
  }
  for (const [id, why] of Object.entries(refused)) {
    assert.match(error(`${id}/m`), why, id)
    assert.match(error(`${id}/m`), /so the gateway can't keep its key out of the sandbox$/, id)
  }
  assert.equal(error('google/gemini-3.8-flash'), '')
  assert.throws(() => openCodeProvider('nope/m'), /OpenCode has no provider "nope"/)
})

test('the gateway swaps the key into each header the provider uses, on each of its hosts', () => {
  const rules = providerTransformations(openCodeProvider('opencode/m'), {
    key: 'real',
    placeholder: 'ph',
    headers: { 'x-extra': '1' },
  })
  assert.deepEqual(rules, [
    {
      matchUrl: 'https://opencode.ai',
      matchHeaders: { authorization: 'Bearer ph' },
      transformHeaders: { 'x-extra': '1', authorization: 'Bearer real' },
    },
    {
      matchUrl: 'https://opencode.ai',
      matchHeaders: { 'x-api-key': 'ph' },
      transformHeaders: { 'x-extra': '1', 'x-api-key': 'real' },
    },
    {
      matchUrl: 'https://opencode.ai',
      matchHeaders: { 'x-goog-api-key': 'ph' },
      transformHeaders: { 'x-extra': '1', 'x-goog-api-key': 'real' },
    },
  ])
})

test('the served model comes from the URL where it names one, else the response', () => {
  const google = openCodeProvider('google/m')
  const openai = openCodeProvider('openai/m')
  const post = { method: 'POST', host: 'generativelanguage.googleapis.com' }
  assert.equal(
    providerServedModel(google, {
      ...post,
      path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
    }),
    'gemini-3.8-flash',
  )
  assert.equal(providerServedModel(google, { ...post, path: '/v1beta/models' }), undefined)
  const responses = { method: 'POST', host: 'api.openai.com', path: '/v1/responses' }
  assert.equal(
    providerServedModel(openai, {
      ...responses,
      responseModel: 'gpt-5.4-mini-2026-03-17',
      responseEffort: 'low',
    }),
    'gpt-5.4-mini-2026-03-17[effort=low]',
  )
  assert.equal(
    providerServedModel(openai, { ...responses, responseModel: 'gpt-5.4-mini' }),
    'gpt-5.4-mini',
  )
  assert.equal(providerServedModel(openai, responses), undefined, 'no response model')
  assert.equal(
    providerServedModel(openai, { ...responses, host: 'api.x.ai', responseModel: 'x' }),
    undefined,
    "another provider's host",
  )
  // OpenCode Zen's config request answers with JSON that names models: it's not a model call.
  assert.equal(
    providerServedModel(openCodeProvider('opencode/m'), {
      method: 'GET',
      host: 'opencode.ai',
      path: '/console/api/v2/config',
      responseModel: 'gpt-5.4',
    }),
    undefined,
  )
})

test("the gateway reads the response of each model call whose URL doesn't name the model", () => {
  const zen = openCodeProvider('opencode/m')
  assert.deepEqual(
    providerModelResponses(zen).map((e) => e.path),
    [
      { exact: '/zen/v1/chat/completions' },
      { exact: '/zen/v1/messages' },
      { exact: '/zen/v1/responses' },
    ],
  )
  assert.equal(providerEndpoints(zen).length, 5)
  assert.deepEqual(providerModelResponses(openCodeProvider('google/m')), [])
})
