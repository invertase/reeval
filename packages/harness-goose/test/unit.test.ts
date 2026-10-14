import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createGoose,
  GOOSE_CLI_SHA256,
  GOOSE_CLI_VERSION,
  GOOSE_CREDENTIAL_ENV,
  GOOSE_INSTALL_COMMAND,
  GOOSE_QUIET_ENV,
  gooseConfig,
  gooseEnv,
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

test('effort is GOOSE_THINKING_EFFORT', () => {
  assert.deepEqual(gooseEnv({ model: 'gemini-3.8-flash' }), {
    ...GOOSE_QUIET_ENV,
    GOOSE_MODEL: 'gemini-3.8-flash',
  })
  assert.deepEqual(gooseEnv({ model: 'gemini-3.8-flash', effort: 'high' }), {
    ...GOOSE_QUIET_ENV,
    GOOSE_MODEL: 'gemini-3.8-flash',
    GOOSE_THINKING_EFFORT: 'high',
  })
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
