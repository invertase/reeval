import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import {
  GOOSE_LAUNCHER,
  GOOSE_LAUNCHER_EXECUTABLE,
  GOOSE_LAUNCHER_PATH,
} from '../src/goose-launcher.ts'
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

const OFF_VERTEX = { REEVAL_GOOSE_ENV: '{}', GOOSE_THINKING_EFFORT: '' }

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
    REEVAL_GOOSE_ENV: JSON.stringify({
      GCP_PROJECT_ID: 'p',
      GCP_LOCATION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS: '/reeval/adc.json',
    }),
  })
  const harness = createGoose({ auth: {}, model: 'gemini-3.8-flash', vertex })
  assert.equal(harness.harnessId, 'goose')
})

test('the image bakes one bootstrap for every provider, model and effort', async () => {
  const gemini = createGoose({ auth: { [GOOSE_CREDENTIAL_ENV]: 'AIza-k' }, model: 'unused' })
  for (const effort of ['medium', 'high']) {
    const at = createGoose({ auth: { [GOOSE_CREDENTIAL_ENV]: 'AIza-k' }, model: 'm', effort })
    assert.deepEqual(await at.getBootstrap?.({}), await gemini.getBootstrap?.({}), effort)
  }
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

/** The bridge's environment, and the files written, on a stand-in sandbox. */
async function started(harness: ReturnType<typeof createGoose>) {
  let env: Record<string, string> | undefined
  const stop = new Error('stop at the bridge')
  const sandboxSession = {
    ports: [4000],
    getPortEndpoint: async () => ({ url: 'http://127.0.0.1:4000' }),
    run: async () => ({ exitCode: 0, stdout: '/home/u', stderr: '' }),
    writeTextFile: async () => {},
    readTextFile: async () => '',
    addRequestTransformations: async () => {},
    spawn: async (o: { env: Record<string, string> }) => {
      env = o.env
      throw stop
    },
  }
  await assert.rejects(
    harness.doStart({ sandboxSession, sessionId: 's', sessionWorkDir: '/w' } as never),
    (e) => e === stop,
  )
  return env ?? {}
}

test("off Vertex AI, none of its variables is set, so the eval's own values reach the agent", async () => {
  const env = await started(createGoose({ auth: { [GOOSE_CREDENTIAL_ENV]: 'AIza-k' }, model: 'm' }))
  for (const name of ['GCP_PROJECT_ID', 'GCP_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.equal(env[name], undefined, name)
  }
  assert.equal(env.REEVAL_GOOSE_ENV, '{}')
})

test('on Vertex AI, its variables reach Goose through the launcher only', async () => {
  const vertex = { project: 'p', location: 'global', credentialsFile: '/reeval/adc.json' }
  const env = await started(createGoose({ auth: {}, model: 'gemini-3.8-flash', vertex }))
  assert.deepEqual(JSON.parse(env.REEVAL_GOOSE_ENV ?? ''), {
    GCP_PROJECT_ID: 'p',
    GCP_LOCATION: 'global',
    GOOGLE_APPLICATION_CREDENTIALS: '/reeval/adc.json',
  })
  assert.equal(env.GCP_PROJECT_ID, undefined)
})

test('the launcher runs Goose beside it with the JSON variables added, and passes on its exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goose-launcher-'))
  const launcher = join(dir, GOOSE_LAUNCHER_EXECUTABLE)
  writeFileSync(launcher, GOOSE_LAUNCHER, { mode: 0o755 })
  writeFileSync(
    join(dir, 'goose'),
    '#!/bin/sh\necho "$* GCP_PROJECT_ID=$GCP_PROJECT_ID OTHER=$OTHER"\nprintenv REEVAL_GOOSE_ENV || echo unset\nexit 3\n',
    { mode: 0o755 },
  )
  const run = spawnSync(launcher, ['acp'], {
    encoding: 'utf8',
    env: { ...process.env, OTHER: 'kept', REEVAL_GOOSE_ENV: '{"GCP_PROJECT_ID":"p"}' },
  })
  assert.equal(run.stdout, 'acp GCP_PROJECT_ID=p OTHER=kept\nunset\n')
  assert.equal(run.status, 3)
  assert.ok(
    GOOSE_LAUNCHER_PATH.endsWith(
      `/.harness-bootstrap/goose/home/.local/bin/${GOOSE_LAUNCHER_EXECUTABLE}`,
    ),
  )
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
