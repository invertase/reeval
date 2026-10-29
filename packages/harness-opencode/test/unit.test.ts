import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createOpenCode,
  OPENCODE_CLI_VERSION,
  openCodeConfig,
  openCodeEnv,
} from '../src/opencode-harness.ts'
import {
  OPENCODE_PACKAGE_JSON,
  OPENCODE_PNPM_LOCK,
  OPENCODE_PNPM_WORKSPACE,
} from '../src/opencode-install.ts'
import { openCodeEffortBody } from '../src/opencode-providers.ts'
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
  // Appended to an eval's own rules, where the last match wins: reeval only denies.
  assert.deepEqual(config.permissions, [
    { action: 'question', resource: '*', effect: 'deny' },
    { action: 'browser', resource: '*', effect: 'deny' },
  ])
  assert.deepEqual(config.websearch, { provider: 'exa' })
  assert.equal('agents' in config, false)
  assert.equal('providers' in config, false)
  assert.equal('mcp' in config, false)
})

test("the model's provider calls over HTTP, where the gateway reads the served model", () => {
  // OpenCode's default for OpenAI and xAI is a Responses WebSocket.
  assert.deepEqual(openCodeConfig({ model: 'openai/gpt-5.4-mini' }).providers, {
    openai: { settings: { transport: 'http' } },
  })
  assert.deepEqual(openCodeConfig({ model: 'openrouter/anthropic/claude-haiku-4.5' }).providers, {
    openrouter: { settings: { transport: 'http' } },
  })
})

test("effort goes in the request body's own field for the model's provider", () => {
  assert.deepEqual(openCodeEffortBody('google/gemini-3.8-flash', 'low'), {
    generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
  })
  assert.deepEqual(openCodeEffortBody('google-vertex/gemini-3.8-flash', 'low'), {
    generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
  })
  assert.deepEqual(openCodeEffortBody('anthropic/claude-sonnet-5-5', 'high'), {
    output_config: { effort: 'high' },
  })
  assert.deepEqual(openCodeEffortBody('openai/gpt-5.4-mini', 'high'), {
    reasoning: { effort: 'high' },
  })
  assert.deepEqual(openCodeEffortBody('openrouter/google/gemini-3.8-flash', 'medium'), {
    reasoning: { effort: 'medium' },
  })
  const thinking = { thinkingConfig: { thinkingLevel: 'low' } }
  assert.deepEqual(openCodeEffortBody('vercel/google/gemini-3.8-flash', 'low'), {
    providerOptions: { google: thinking, vertex: thinking },
  })
  assert.deepEqual(openCodeConfig({ model: 'openai/gpt-5.4-mini', effort: 'high' }).providers, {
    openai: {
      settings: { transport: 'http' },
      models: { 'gpt-5.4-mini': { body: { reasoning: { effort: 'high' } } } },
    },
  })
})

test('twin: effort on a provider with no checked field is refused, not dropped', () => {
  for (const model of ['vercel/anthropic/claude-haiku-4-5', 'mistral/large']) {
    assert.equal(openCodeEffortBody(model, 'high'), undefined, model)
  }
  assert.throws(
    () =>
      createOpenCode({
        auth: { AI_GATEWAY_API_KEY: 'k' },
        model: 'vercel/anthropic/claude-haiku-4-5',
        effort: 'high',
      }),
    /OpenCode's effort on vercel\/anthropic\/claude-haiku-4-5 goes in no field reeval has checked/,
  )
  assert.equal(
    'models' in
      (openCodeConfig({ model: 'vercel/anthropic/claude-haiku-4-5', effort: 'high' }).providers
        ?.vercel ?? {}),
    false,
  )
})

test("session titles run on the turn's model, not a second one", () => {
  assert.deepEqual(openCodeConfig({ model: 'google/gemini-3.8-flash' }).agents, {
    title: { model: 'google/gemini-3.8-flash' },
  })
  const env = openCodeEnv({ model: 'google/gemini-3.8-flash' })
  assert.deepEqual(
    JSON.parse(env.OPENCODE_CONFIG_CONTENT),
    openCodeConfig({ model: 'google/gemini-3.8-flash' }),
  )
  // Only variables OpenCode reads, and the gate's.
  assert.deepEqual(Object.keys(env).sort(), [
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_MODELS_FETCH',
    'REEVAL_OPENCODE_MCP_SERVERS',
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
  assert.deepEqual(JSON.parse(openCodeEnv({ mcpServers }).REEVAL_OPENCODE_MCP_SERVERS), [
    'stamp',
    'docs',
  ])
  assert.deepEqual(JSON.parse(openCodeEnv().REEVAL_OPENCODE_MCP_SERVERS), [])
})

test("the catalog names OpenCode's tools, with its path inputs", () => {
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

test("auth is an environment with the model's provider's key, or it throws", () => {
  const model = 'anthropic/claude-haiku-4-5'
  assert.throws(
    () => createOpenCode({ auth: {}, model }),
    /OpenCode auth must be an environment object with ANTHROPIC_API_KEY \(the Anthropic key for anthropic\/claude-haiku-4-5\)/,
  )
  assert.throws(
    () => createOpenCode({ auth: { GOOGLE_GENERATIVE_AI_API_KEY: 'k' }, model }),
    /with ANTHROPIC_API_KEY/,
  )
  assert.throws(() => createOpenCode({ auth: 'auto' as never, model }), /OpenCode auth must be/)
  assert.equal(createOpenCode({ auth: { ANTHROPIC_API_KEY: 'k' }, model }).harnessId, 'opencode')
})

test('a model without a brokerable provider throws, saying why', () => {
  assert.throws(
    () => createOpenCode({ auth: { X: 'k' }, model: 'gemini-3.8-flash' }),
    /names its provider, <provider>\/<model>/,
  )
  assert.throws(
    () => createOpenCode({ auth: { X: 'k' }, model: 'google-vertex/gemini-3.8-flash' }),
    /can't run OpenCode on Vertex \(google-vertex\): it takes a service account/,
  )
  assert.throws(
    () =>
      createOpenCode({
        auth: { AWS_BEARER_TOKEN_BEDROCK: 'k' },
        model: 'amazon-bedrock/m',
        vars: { AWS_REGION: 'evil.example.com' },
      }),
    /AWS_REGION is "evil\.example\.com", which isn't one Amazon Bedrock \(amazon-bedrock\) takes/,
  )
})

test('on Vertex AI, OpenCode runs a google-vertex/<model> id on a credentials file, with no key', () => {
  const vertex = { project: 'p', location: 'global', credentialsFile: '/reeval/adc.json' }
  const harness = createOpenCode({ auth: {}, model: 'google-vertex/gemini-3.8-flash', vertex })
  assert.equal(harness.harnessId, 'opencode')
  assert.throws(
    () => createOpenCode({ auth: {}, model: 'google/gemini-3.8-flash', vertex }),
    /OpenCode on Vertex AI runs a google-vertex\/<model> id/,
  )
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createOpenCode({
    auth: { OPENAI_API_KEY: 'sk-k' },
    model: 'openai/gpt-5.4-mini',
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker OPENAI_API_KEY .* so the key stays out of it/,
  )
})
