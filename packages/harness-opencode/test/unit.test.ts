import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createOpenCode,
  googleModel,
  OPENCODE_CLI_VERSION,
  OPENCODE_CREDENTIAL_ENV,
  openCodeConfig,
  openCodeEnv,
} from '../src/opencode-harness.ts'
import {
  OPENCODE_PACKAGE_JSON,
  OPENCODE_PNPM_LOCK,
  OPENCODE_PNPM_WORKSPACE,
} from '../src/opencode-install.ts'
import { OPENCODE_BUILTIN_TOOLS } from '../src/opencode-tools.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the install, its lockfile and its allowed build pin one @opencode/cli release', () => {
  assert.deepEqual(JSON.parse(OPENCODE_PACKAGE_JSON).dependencies, {
    '@opencode/cli': OPENCODE_CLI_VERSION,
  })
  assert.match(OPENCODE_PNPM_LOCK, new RegExp(`^  '@opencode/cli@${OPENCODE_CLI_VERSION}':$`, 'm'))
  assert.match(
    OPENCODE_PNPM_LOCK,
    new RegExp(`^  '@opencode/cli-linux-x64@${OPENCODE_CLI_VERSION}':$`, 'm'),
  )
  assert.ok(
    OPENCODE_PNPM_WORKSPACE.startsWith(
      `allowBuilds:\n  '@opencode/cli@${OPENCODE_CLI_VERSION}': true\n`,
    ),
  )
  assert.doesNotMatch(OPENCODE_PNPM_LOCK, /opencode-ai/)
})

test('the musl builds are left out of the install, and only those', () => {
  const ignored = (text: string) =>
    [...text.matchAll(/^ {2}- '(@opencode\/cli-[^']+)'$/gm)].map((m) => m[1])
  const musl = [
    '@opencode/cli-linux-arm64-musl',
    '@opencode/cli-linux-x64-baseline-musl',
    '@opencode/cli-linux-x64-musl',
  ]
  assert.deepEqual(ignored(OPENCODE_PNPM_WORKSPACE), musl)
  assert.deepEqual(ignored(OPENCODE_PNPM_LOCK), musl)
  assert.doesNotMatch(OPENCODE_PNPM_LOCK, /^ {2}'@opencode\/cli-linux-x64-musl@/m)
  assert.match(OPENCODE_PNPM_LOCK, /^ {2}'@opencode\/cli-linux-x64-baseline@/m)
})

test('the config turns off updates, sharing and the tools an eval has no use for', () => {
  const config = openCodeConfig()
  assert.equal(config.update, 'disable')
  assert.equal(config.share, 'disabled')
  // Appended to an eval's own rules, where the last match wins: ES only denies.
  assert.deepEqual(config.permissions, [
    { action: 'question', resource: '*', effect: 'deny' },
    { action: 'browser', resource: '*', effect: 'deny' },
  ])
  assert.deepEqual(config.websearch, { provider: 'exa' })
  assert.equal('agents' in config, false)
  assert.equal('mcp' in config, false)
})

test("session titles run on the turn's model, not a second one", () => {
  assert.deepEqual(openCodeConfig({ model: 'gemini-3.8-flash' }).agents, {
    title: { model: 'google/gemini-3.8-flash' },
  })
  const env = openCodeEnv({ model: 'gemini-3.8-flash' })
  assert.deepEqual(
    JSON.parse(env.OPENCODE_CONFIG_CONTENT),
    openCodeConfig({ model: 'gemini-3.8-flash' }),
  )
  // Only variables 2.0.18 still reads, and the gate's.
  assert.deepEqual(Object.keys(env).sort(), [
    'ES_OPENCODE_MCP_SERVERS',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_MODELS_FETCH',
  ])
})

test('MCP servers go in the config with codemode off, and the gate waits for them', () => {
  const mcpServers = {
    stamp: { type: 'local', command: ['node', 's.mjs'], environment: { A: 'b' } },
    docs: { type: 'remote', url: 'https://docs.test/mcp', headers: {}, oauth: false },
  } as const
  assert.deepEqual(openCodeConfig({ mcpServers }).mcp, {
    servers: {
      stamp: {
        type: 'local',
        command: ['node', 's.mjs'],
        environment: { A: 'b' },
        codemode: false,
      },
      docs: {
        type: 'remote',
        url: 'https://docs.test/mcp',
        headers: {},
        oauth: false,
        codemode: false,
      },
    },
  })
  assert.deepEqual(JSON.parse(openCodeEnv({ mcpServers }).ES_OPENCODE_MCP_SERVERS), [
    'stamp',
    'docs',
  ])
  assert.deepEqual(JSON.parse(openCodeEnv().ES_OPENCODE_MCP_SERVERS), [])
})

test("the catalog names 2.0.18's tools, with its path inputs", () => {
  assert.equal(OPENCODE_BUILTIN_TOOLS.bash.nativeName, 'shell')
  assert.deepEqual(Object.keys(OPENCODE_BUILTIN_TOOLS).sort(), [
    'bash',
    'edit',
    'execute',
    'glob',
    'grep',
    'read',
    'skill',
    'subagent',
    'webFetch',
    'webSearch',
    'write',
  ])
  for (const name of ['read', 'write', 'edit'] as const) {
    const schema = OPENCODE_BUILTIN_TOOLS[name].inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean }
    }
    assert.equal(
      schema.safeParse({ path: 'a.txt', content: '', oldString: '', newString: '' }).success,
      true,
    )
    assert.equal(
      schema.safeParse({ filePath: 'a.txt', content: '', oldString: '', newString: '' }).success,
      false,
    )
  }
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
