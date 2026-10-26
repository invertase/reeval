import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  AI_GATEWAY_PROVIDER,
  createGoose,
  GOOSE_CLI_SHA256,
  GOOSE_CLI_VERSION,
  GOOSE_CREDENTIAL_ENV,
  GOOSE_INSTALL_COMMAND,
  GOOSE_QUIET_ENV,
  gooseConfig,
  gooseEnv,
  OPENROUTER_PROVIDER,
} from '../src/goose-harness.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the install downloads the pinned release and checks its sha256 on both arches', () => {
  assert.ok(GOOSE_INSTALL_COMMAND.includes(`/download/v${GOOSE_CLI_VERSION}/goose-$arch-`))
  for (const sha of Object.values(GOOSE_CLI_SHA256)) {
    assert.match(sha, /^[0-9a-f]{64}$/)
    assert.ok(GOOSE_INSTALL_COMMAND.includes(`sha=${sha}`))
  }
  assert.ok(GOOSE_INSTALL_COMMAND.includes('sha256sum -c'))
})

test('auth is an environment with the Gemini key, or it throws', () => {
  assert.throws(
    () => createGoose({ auth: {}, model: 'm' }),
    /Goose auth must be an environment object with GOOGLE_API_KEY/,
  )
  const harness = createGoose({ auth: { [GOOSE_CREDENTIAL_ENV]: 'AIza-k' }, model: 'm' })
  assert.equal(harness.harnessId, 'goose')
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createGoose({
    auth: { [GOOSE_CREDENTIAL_ENV]: 'AIza-k' },
    model: 'm',
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker GOOGLE_API_KEY .* so the key stays out of it/,
  )
})

const OFF_VERTEX = { GCP_PROJECT_ID: '', GCP_LOCATION: '', GOOGLE_APPLICATION_CREDENTIALS: '' }

test('effort is GOOSE_THINKING_EFFORT', () => {
  assert.deepEqual(gooseEnv({ model: 'gemini-3.8-flash' }), {
    ...GOOSE_QUIET_ENV,
    ...OFF_VERTEX,
    GOOSE_PROVIDER: 'google',
    GOOSE_MODEL: 'gemini-3.8-flash',
  })
  assert.deepEqual(gooseEnv({ model: 'gemini-3.8-flash', effort: 'high' }), {
    ...GOOSE_QUIET_ENV,
    ...OFF_VERTEX,
    GOOSE_PROVIDER: 'google',
    GOOSE_MODEL: 'gemini-3.8-flash',
    GOOSE_THINKING_EFFORT: 'high',
  })
})

test("on Vercel AI Gateway, Goose runs its vercel_ai_gateway provider on Vercel's key", () => {
  assert.deepEqual(gooseEnv({ model: 'google/gemini-3-flash', provider: AI_GATEWAY_PROVIDER }), {
    ...GOOSE_QUIET_ENV,
    ...OFF_VERTEX,
    GOOSE_PROVIDER: 'vercel_ai_gateway',
    GOOSE_MODEL: 'google/gemini-3-flash',
  })
  assert.throws(
    () =>
      createGoose({
        auth: { [GOOSE_CREDENTIAL_ENV]: 'AIza-k' },
        provider: AI_GATEWAY_PROVIDER,
        model: 'm',
      }),
    /with AI_GATEWAY_API_KEY \(a Vercel AI Gateway key\)/,
  )
  const harness = createGoose({
    auth: { AI_GATEWAY_API_KEY: 'vck_k' },
    provider: AI_GATEWAY_PROVIDER,
    model: 'google/gemini-3-flash',
  })
  assert.equal(harness.harnessId, 'goose')
})

test("on OpenRouter, Goose runs its openrouter provider on OpenRouter's key", () => {
  assert.deepEqual(gooseEnv({ model: 'google/gemini-3-flash', provider: OPENROUTER_PROVIDER }), {
    ...GOOSE_QUIET_ENV,
    ...OFF_VERTEX,
    GOOSE_PROVIDER: 'openrouter',
    GOOSE_MODEL: 'google/gemini-3-flash',
  })
  assert.throws(
    () =>
      createGoose({ auth: { AI_GATEWAY_API_KEY: 'k' }, provider: OPENROUTER_PROVIDER, model: 'm' }),
    /with OPENROUTER_API_KEY \(an OpenRouter key\)/,
  )
})

test('on Vertex AI, Goose runs its gcp_vertex_ai provider on a credentials file, with no key', () => {
  const vertex = { project: 'p', location: 'global', credentialsFile: '/reeval/adc.json' }
  assert.deepEqual(gooseEnv({ model: 'gemini-3.8-flash', vertex }), {
    ...GOOSE_QUIET_ENV,
    ...OFF_VERTEX,
    GOOSE_PROVIDER: 'gcp_vertex_ai',
    GOOSE_MODEL: 'gemini-3.8-flash',
    GCP_PROJECT_ID: 'p',
    GCP_LOCATION: 'global',
    GOOGLE_APPLICATION_CREDENTIALS: '/reeval/adc.json',
  })
  const harness = createGoose({ auth: {}, model: 'gemini-3.8-flash', vertex })
  assert.equal(harness.harnessId, 'goose')
})

test('the image bakes one bootstrap for every provider and model', async () => {
  const gemini = createGoose({ auth: { [GOOSE_CREDENTIAL_ENV]: 'AIza-k' }, model: 'unused' })
  const vercel = createGoose({
    auth: { AI_GATEWAY_API_KEY: 'vck_k' },
    provider: AI_GATEWAY_PROVIDER,
    model: 'google/gemini-3-flash',
  })
  const openrouter = createGoose({
    auth: { OPENROUTER_API_KEY: 'sk-or-k' },
    provider: OPENROUTER_PROVIDER,
    model: 'google/gemini-3-flash',
  })
  assert.deepEqual(await vercel.getBootstrap?.({}), await gemini.getBootstrap?.({}))
  assert.deepEqual(await openrouter.getBootstrap?.({}), await gemini.getBootstrap?.({}))
  const vertex = createGoose({
    auth: {},
    model: 'gemini-3.8-flash',
    vertex: { project: 'p', location: 'global', credentialsFile: '/reeval/adc.json' },
  })
  assert.deepEqual(await vertex.getBootstrap?.({}), await gemini.getBootstrap?.({}))
})

test("MCP servers are enabled extensions in Goose's config.yaml", () => {
  const file = gooseConfig({ stamp: { type: 'stdio', cmd: 'node', args: ['s.mjs'], envs: {} } })
  assert.equal(file.path, '.config/goose/config.yaml')
  assert.deepEqual(JSON.parse(file.content), {
    extensions: {
      stamp: {
        name: 'stamp',
        enabled: true,
        timeout: 300,
        type: 'stdio',
        cmd: 'node',
        args: ['s.mjs'],
        envs: {},
      },
    },
  })
})
