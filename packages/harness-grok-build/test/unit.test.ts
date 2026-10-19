import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createGrokBuild,
  GROK_CLI_INTEGRITY,
  GROK_CLI_VERSION,
  GROK_CREDENTIAL_ENV,
  GROK_INSTALL_COMMAND,
  grokConfig,
} from '../src/grok-build-harness.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the install downloads the pinned native build and checks its sha512 on both arches', () => {
  assert.ok(
    GROK_INSTALL_COMMAND.includes(
      `/@xai-official/grok-linux-$arch/-/grok-linux-$arch-${GROK_CLI_VERSION}.tgz`,
    ),
  )
  for (const sri of Object.values(GROK_CLI_INTEGRITY)) {
    assert.match(sri, /^sha512-[A-Za-z0-9+/]{86}==$/)
    assert.ok(GROK_INSTALL_COMMAND.includes(`sri=${sri}`))
  }
  assert.ok(GROK_INSTALL_COMMAND.includes('does not match its sha512'))
})

test('auth is an environment with the xAI key, or it throws', () => {
  assert.throws(
    () => createGrokBuild({ auth: {}, model: 'm' }),
    /Grok Build auth must be an environment object with XAI_API_KEY/,
  )
  const harness = createGrokBuild({ auth: { [GROK_CREDENTIAL_ENV]: 'xai-k' }, model: 'm' })
  assert.equal(harness.harnessId, 'grok-build')
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createGrokBuild({
    auth: { [GROK_CREDENTIAL_ENV]: 'xai-k' },
    model: 'm',
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker XAI_API_KEY .* so the key stays out of it/,
  )
})

test("config.toml puts every call on the run's model and turns off the extra calls", () => {
  const file = grokConfig({ model: 'grok-4.6' })
  assert.equal(file.path, '.grok/config.toml')
  assert.match(file.content, /^\[models\]\ndefault = "grok-4\.6"\nsession_summary = "grok-4\.6"\n/)
  for (const off of [
    'telemetry',
    'feedback',
    'managed_config',
    'campaigns',
    'title_refresh',
    'turn_summary',
    'session_recap',
    'auto_update',
  ]) {
    assert.ok(file.content.includes(`\n${off} = false\n`), off)
  }
  assert.equal(file.content.includes('default_reasoning_effort'), false)
})

test("effort is the config's default_reasoning_effort", () => {
  assert.match(
    grokConfig({ model: 'grok-4.6', effort: 'high' }).content,
    /\ndefault_reasoning_effort = "high"\n/,
  )
})
