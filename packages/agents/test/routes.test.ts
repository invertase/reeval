// The routes as data: where each one's APIs are, the key a harness takes there and the model id
// it names, and Vercel's base URL and credential checks.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { HARNESSES } from '../src/catalog/index.ts'
import { anthropicPath, apiHost, openaiPath } from '../src/routes/api.ts'
import { openCodeModelOn, ROUTES } from '../src/routes/index.ts'
import { anthropicOnOpenRouter } from '../src/routes/openrouter.ts'
import {
  jwtExpiry,
  VERCEL_API,
  vercelApi,
  vercelBaseUrl,
  vercelBaseUrlProblem,
  vercelCredentialProblem,
} from '../src/routes/vercel.ts'
import { VERTEX_REFUSALS, VERTEX_ROUTES, vertexHarnessModel } from '../src/routes/vertex.ts'

const BASE = 'https://gw.example/proxy'
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
const KINDS = Object.keys(HARNESSES) as (keyof typeof HARNESSES)[]

describe('routes', () => {
  test('each route serves a harness or says why not, never both', () => {
    for (const route of [...Object.values(ROUTES)]) {
      for (const kind of KINDS) {
        const served = route.routes[kind] !== undefined
        assert.notEqual(served, route.refusals[kind] !== undefined, `${route.name}: ${kind}`)
      }
    }
    for (const kind of KINDS) {
      assert.ok(!(VERTEX_ROUTES[kind] && VERTEX_REFUSALS[kind]), `Vertex AI: ${kind}`)
    }
  })

  test('the model id each route names', () => {
    const id = (route: keyof typeof ROUTES, kind: keyof typeof HARNESSES, model: string) =>
      ROUTES[route].routes[kind]?.({})?.modelId?.(model) ?? model
    assert.equal(id('vercel', 'codex', 'gpt-5.4-mini'), 'openai/gpt-5.4-mini')
    assert.equal(id('vercel', 'grok-build', 'grok-4.7'), 'xai/grok-4.7')
    assert.equal(
      id('vercel', 'opencode', 'google/gemini-3.8-flash'),
      'vercel/google/gemini-3.8-flash',
    )
    assert.equal(id('openrouter', 'grok-build', 'grok-4.7'), 'x-ai/grok-4.7')
    assert.equal(id('openrouter', 'claude-code', 'claude-haiku-4-5'), 'anthropic/claude-haiku-4.5')
    assert.equal(anthropicOnOpenRouter('anthropic/claude-haiku-4-5'), 'anthropic/claude-haiku-4-5')
    assert.equal(
      VERTEX_ROUTES['claude-code']?.modelId('claude-haiku-4-5-20251001'),
      'claude-haiku-4-5@20251001',
    )
    assert.equal(VERTEX_ROUTES.goose?.modelId('google/gemini-3.8-flash'), 'gemini-3.8-flash')
    assert.equal(
      vertexHarnessModel('antigravity', 'gemini-3.8-flash-high'),
      'google/gemini-3.8-flash',
    )
  })

  test("OpenCode's id on a route is the route's provider", () => {
    assert.equal(openCodeModelOn('m', 'vercel'), 'vercel/m')
    assert.equal(openCodeModelOn('m', 'openrouter'), 'openrouter/m')
    assert.equal(openCodeModelOn('google/m', 'vertex'), 'google-vertex/m')
    assert.equal(openCodeModelOn('anthropic/m', 'direct'), 'anthropic/m')
  })

  test('openaiPath and anthropicPath put an endpoint under the API base', () => {
    const api = {
      origin: 'https://gw.example',
      openai: 'https://gw.example/api/v1/',
      anthropic: 'https://gw.example',
    }
    assert.equal(apiHost(api), 'gw.example')
    assert.equal(openaiPath(api, '/chat/completions'), '/api/v1/chat/completions')
    assert.equal(anthropicPath(api, '/v1/messages'), '/v1/messages')
  })

  test("vercel()'s API moves to it, path and all; unset, it's Vercel's own", () => {
    assert.deepEqual(vercelApi({}), VERCEL_API)
    assert.deepEqual(vercelApi({ AI_GATEWAY_BASE_URL: `${BASE}//` }), {
      origin: BASE,
      openai: `${BASE}/v1`,
      anthropic: BASE,
    })
    assert.equal(vercelBaseUrl({}), undefined)
    assert.equal(vercelBaseUrl({ AI_GATEWAY_BASE_URL: `${BASE}/` }), BASE)
  })

  test('only an https:// URL that reads as written, with nothing the agents would lose, is a gateway', () => {
    const fix =
      'Set AI_GATEWAY_BASE_URL to an https:// URL such as https://gateway.example.com, or unset it to call Vercel AI Gateway.'
    const problem = (value: string) => vercelBaseUrlProblem({ AI_GATEWAY_BASE_URL: value })
    assert.equal(problem(BASE), undefined)
    assert.equal(problem(`${BASE}/`), undefined)
    assert.equal(vercelBaseUrlProblem({}), undefined)
    assert.equal(problem('gw.example'), `AI_GATEWAY_BASE_URL ("gw.example") isn't a URL. ${fix}`)
    assert.equal(
      problem('http://gw.example'),
      `AI_GATEWAY_BASE_URL ("http://gw.example") isn't https://, and reeval sends the key only over HTTPS. ${fix}`,
    )
    for (const value of [
      'https://gw.example/?k=1',
      'https://gw.example/#a',
      'https://u@gw.example',
    ]) {
      assert.match(problem(value) ?? '', /has a query, a fragment or a user/, value)
    }
    const rewritten = {
      'https://gw.example/p?': 'https://gw.example/p',
      'https://gw.example/p#': 'https://gw.example/p',
      ' https://gw.example/p': 'https://gw.example/p',
      'https://gw.exa\nmple/p': 'https://gw.example/p',
      'https:gw.example/p': 'https://gw.example/p',
    }
    for (const [value, base] of Object.entries(rewritten)) {
      assert.equal(
        problem(value),
        `AI_GATEWAY_BASE_URL (${JSON.stringify(value)}) reads as ${base}, and reeval sends the key only to a URL written as it reads. ${fix}`,
      )
    }
    assert.deepEqual(
      vercelApi({ AI_GATEWAY_BASE_URL: 'https:gw.example/p' }).origin,
      BASE.replace('/proxy', '/p'),
    )
  })

  test("an expired project token is refused before the run; a live one, or a key, isn't", () => {
    const noon = new Date('2026-01-01T12:00:00Z')
    const at = (iso: string) => Date.parse(iso) / 1000
    assert.equal(
      jwtExpiry(jwt(at('2026-01-01T00:00:00Z')))?.toISOString(),
      '2026-01-01T00:00:00.000Z',
    )
    const claims = Buffer.from(JSON.stringify({ sub: 'ü>>?~', exp: at('2026-01-01T00:00:00Z') }))
    const urlSafe = claims.toString('base64url')
    assert.match(urlSafe, /-/)
    assert.equal(jwtExpiry(`e30.${urlSafe}.s`)?.toISOString(), '2026-01-01T00:00:00.000Z')
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
