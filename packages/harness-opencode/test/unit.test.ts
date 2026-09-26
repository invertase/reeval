import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createOpenCode,
  googleModel,
  OPENCODE_CLI_VERSION,
  OPENCODE_CREDENTIAL_ENV,
  OPENCODE_WARM_COMMAND,
} from '../src/opencode-harness.ts'
import {
  OPENCODE_PACKAGE_JSON,
  OPENCODE_PNPM_LOCK,
  OPENCODE_PNPM_WORKSPACE,
} from '../src/opencode-install.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the install, its lockfile, its allowed build and the warm step pin one release', () => {
  assert.deepEqual(JSON.parse(OPENCODE_PACKAGE_JSON).dependencies, {
    'opencode-ai': OPENCODE_CLI_VERSION,
  })
  assert.match(OPENCODE_PNPM_LOCK, new RegExp(`^  opencode-ai@${OPENCODE_CLI_VERSION}:$`, 'm'))
  assert.match(
    OPENCODE_PNPM_LOCK,
    new RegExp(`^  opencode-linux-x64@${OPENCODE_CLI_VERSION}:$`, 'm'),
  )
  assert.equal(
    OPENCODE_PNPM_WORKSPACE,
    `allowBuilds:\n  'opencode-ai@${OPENCODE_CLI_VERSION}': true\n`,
  )
  assert.ok(OPENCODE_WARM_COMMAND.includes(`"%s"}}\\n' ${OPENCODE_CLI_VERSION} `))
})

test('auth is an environment with the Gemini key, or it throws', () => {
  assert.throws(
    () => createOpenCode({ auth: {} }),
    /OpenCode auth must be an environment object with GOOGLE_GENERATIVE_AI_API_KEY/,
  )
  assert.throws(() => createOpenCode({ auth: 'auto' as never }), /OpenCode auth must be/)
  assert.equal(
    createOpenCode({ auth: { [OPENCODE_CREDENTIAL_ENV]: 'AIza-k' } }).harnessId,
    'opencode',
  )
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createOpenCode({
    auth: { [OPENCODE_CREDENTIAL_ENV]: 'AIza-k' },
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker GOOGLE_GENERATIVE_AI_API_KEY .* so the key stays out of it/,
  )
})

test("a Gemini model id runs on OpenCode's google provider", () => {
  assert.equal(googleModel('gemini-3.8-flash'), 'google/gemini-3.8-flash')
  assert.equal(googleModel('google/gemini-3.8-flash'), 'google/gemini-3.8-flash')
})
