import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { getPiBootstrap, PI_CLI_VERSION } from '../src/pi-bootstrap.ts'
import { buildPiCommand, createPi, PI_CREDENTIAL_ENV } from '../src/pi-harness.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the bootstrap installs the pinned pi from its lockfile, without build scripts', async () => {
  const b = await getPiBootstrap()
  const manifest = b.files?.find((f) => f.path.endsWith('/package.json'))
  const lock = b.files?.find((f) => f.path.endsWith('/pnpm-lock.yaml'))
  assert.deepEqual(JSON.parse(String(manifest?.content)).dependencies, {
    '@earendil-works/pi-coding-agent': PI_CLI_VERSION,
  })
  assert.match(
    String(lock?.content),
    new RegExp(`^  '@earendil-works/pi-coding-agent@${PI_CLI_VERSION}':$`, 'm'),
  )
  assert.deepEqual(b.commands, [
    { command: 'pnpm install --frozen-lockfile --prod --ignore-scripts' },
  ])
})

test('each turn runs pi in print mode on one session id, the prompt from its file', () => {
  const command = buildPiCommand({
    cli: '/h/pi',
    workDir: '/es/workspace',
    promptFile: '/d/prompt-1.txt',
    model: 'gemini-3.8-flash',
    sessionId: 'abc',
    sessionDir: '/h/.pi/agent/sessions',
  })
  assert.equal(
    command,
    `cd '/es/workspace' && exec '/h/pi' --mode json -p --offline --approve --no-extensions --provider google --model 'gemini-3.8-flash' --session-id 'abc' --session-dir '/h/.pi/agent/sessions' -- "$(cat '/d/prompt-1.txt')"`,
  )
})

test('auth is an environment with the Gemini key, or it throws', () => {
  assert.throws(
    () => createPi({ auth: {} }),
    /pi auth must be an environment object with GEMINI_API_KEY/,
  )
  assert.equal(createPi({ auth: { [PI_CREDENTIAL_ENV]: 'AIza-k' } }).harnessId, 'pi')
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createPi({
    auth: { [PI_CREDENTIAL_ENV]: 'AIza-k' },
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker GEMINI_API_KEY .* so the key stays out of it/,
  )
})
