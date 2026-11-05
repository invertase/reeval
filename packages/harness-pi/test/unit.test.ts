import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { getPiBootstrap, PI_CLI_VERSION, piGatewayModelsScript } from '../src/pi-bootstrap.ts'
import {
  buildPiCommand,
  buildPiMcpConfig,
  createPi,
  escapePiConfigValue,
  PI_AI_GATEWAY,
  PI_MCP_FILE,
  PI_OPENROUTER,
  type PiGateway,
  type PiHarnessSettings,
  type PiMcpServer,
  type PiModelInfo,
} from '../src/pi-harness.ts'
import { PROBED_VERSION } from '../src/pi-provider-table.ts'
import { type PiProvider, piProvider } from '../src/pi-providers.ts'
import { VERSION } from '../src/version.ts'

const provider = (id: string) => piProvider(id) as PiProvider
const GOOGLE = provider('google')

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const PI_LOCKED_AI = /'@earendil-works\/pi-ai@([\d.]+)':/.exec(
  readFileSync(new URL('../assets/pnpm-lock.yaml', import.meta.url), 'utf8'),
)?.[1]

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
    workDir: '/reeval/workspace',
    promptFile: '/d/prompt-1.txt',
    model: 'gemini-3.8-flash',
    sessionId: 'abc',
    sessionDir: '/h/.pi/agent/sessions',
    provider: 'google',
  })
  assert.equal(
    command,
    `cd '/reeval/workspace' && exec '/h/pi' --mode json -p --offline --approve --no-extensions --provider 'google' --model 'gemini-3.8-flash' --session-id 'abc' --session-dir '/h/.pi/agent/sessions' -- "$(cat '/d/prompt-1.txt')"`,
  )
})

test("with MCP servers, the turn loads pi's built-in mcp extension and no other", () => {
  const command = buildPiCommand({
    cli: '/h/pi',
    workDir: '/w',
    promptFile: '/d/p.txt',
    model: undefined,
    sessionId: 'abc',
    sessionDir: '/s',
    mcp: true,
    provider: 'google',
  })
  assert.match(command, / --approve --no-extensions -e builtin:mcp --provider 'google' /)
})

test('effort is --thinking', () => {
  const command = buildPiCommand({
    cli: '/h/pi',
    workDir: '/w',
    promptFile: '/d/p.txt',
    model: 'gemini-3.8-flash',
    sessionId: 'abc',
    sessionDir: '/s',
    thinking: 'high',
    provider: 'google',
  })
  assert.match(command, / --model 'gemini-3\.8-flash' --thinking 'high' --session-id /)
})

test('env and header values are escaped so pi reads them literally', () => {
  assert.equal(escapePiConfigValue('plain'), 'plain')
  assert.equal(escapePiConfigValue('$HOME'), '$$HOME')
  // biome-ignore lint/suspicious/noTemplateCurlyInString: pi's own ${NAME} syntax
  assert.equal(escapePiConfigValue('a${B}c$$'), 'a$${B}c$$$$')
  assert.equal(escapePiConfigValue('!rm -rf /'), '$!rm -rf /')
  assert.equal(escapePiConfigValue('!echo $X'), '$!echo $$X')
  assert.equal(escapePiConfigValue('$!x'), '$$!x')
  assert.equal(escapePiConfigValue('not!first'), 'not!first')
})

test("each escaped value resolves, under pi's expansion rules, to the value as written", () => {
  // pi's rules (core/resolve-config-value.js): a leading `!` runs a command; otherwise
  // `$$` and `$!` are literals and `$NAME` or `${NAME}` expands.
  const resolve = (config: string) => {
    if (config.startsWith('!')) return { command: config.slice(1) }
    return config.replace(/\$(\$|!|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (m, r) =>
      r === '$' || r === '!' ? r : `<env ${m}>`,
    )
  }
  for (const value of [
    'plain',
    '$HOME',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pi's own ${NAME} syntax
    '${TOKEN}',
    'Bearer $X',
    '!id',
    '!a$b',
    '$!',
    '$$',
    'x!',
  ]) {
    assert.equal(resolve(escapePiConfigValue(value)), value)
  }
})

test('mcp.json declares every server directly, with literal env and headers, and no codemode', () => {
  const config = JSON.parse(
    buildPiMcpConfig({
      stamp: { command: 'node', args: ['stamp.mjs'], env: { TOKEN: '$SECRET', RUN: '!id' } },
      docs: { url: 'https://mcp.example.com/mcp', headers: { 'x-api-key': 'k$1' } },
      bare: { command: 'mcp' },
    }),
  )
  assert.deepEqual(config, {
    mcpServers: {
      stamp: {
        command: 'node',
        args: ['stamp.mjs'],
        env: { TOKEN: '$$SECRET', RUN: '$!id' },
        exposure: 'direct',
      },
      docs: {
        url: 'https://mcp.example.com/mcp',
        headers: { 'x-api-key': 'k$$1' },
        exposure: 'direct',
      },
      bare: { command: 'mcp', args: [], env: {}, exposure: 'direct' },
    },
    autoEnableCodemode: false,
  })
})

/** A sandbox that brokers and records what's written and spawned. */
function recordingSandbox(stdout: string[] = []) {
  const writes: Array<{ path: string; content: string }> = []
  const spawned: string[] = []
  const envs: Array<Record<string, string>> = []
  const transformations: unknown[] = []
  const stream = (lines: string[] = []) =>
    new ReadableStream<Uint8Array>({
      start: (c) => {
        for (const line of lines) c.enqueue(new TextEncoder().encode(`${line}\n`))
        c.close()
      },
    })
  const sandbox = {
    addRequestTransformations: async (t: unknown[]) => {
      transformations.push(...t)
    },
    run: async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' }),
    readTextFile: async () => null,
    writeTextFile: async (o: { path: string; content: string }) => {
      writes.push({ path: o.path, content: o.content })
    },
    spawn: async (o: { command: string; env: Record<string, string> }) => {
      spawned.push(o.command)
      envs.push(o.env)
      return {
        stdout: stream(stdout),
        stderr: stream(),
        wait: async () => ({ exitCode: 0 }),
        kill: async () => {},
      }
    },
  }
  return { sandbox, writes, spawned, envs, transformations }
}

async function oneTurn(
  mcpServers?: Record<string, PiMcpServer>,
  stdout?: string[],
  settings: Partial<PiHarnessSettings> = { auth: { GEMINI_API_KEY: 'AIza-k' }, provider: GOOGLE },
  model?: string,
) {
  const { sandbox, writes, spawned, envs, transformations } = recordingSandbox(stdout)
  const parts: HarnessV1StreamPart[] = []
  const harness = createPi({
    auth: {},
    ...settings,
    ...(mcpServers ? { mcpServers } : {}),
    requireCredentialBrokering: true,
  })
  const session = await harness.doStart({
    sandboxSession: sandbox,
    sessionWorkDir: '/w',
    sessionId: 's1',
  } as never)
  const control = await session.doPromptTurn({
    prompt: 'hi',
    ...(model ? { model } : {}),
    tools: [],
    skills: [],
    emit: (part: HarnessV1StreamPart) => parts.push(part),
  } as never)
  await control.done
  return { writes, spawned, envs, parts, transformations }
}

test('a session with MCP servers writes mcp.json under the home and loads the mcp extension', async () => {
  const { writes, spawned } = await oneTurn({ stamp: { command: 'node', args: ['stamp.mjs'] } })
  const mcp = writes.find((w) => w.path.endsWith(`/${PI_MCP_FILE}`))
  assert.equal(mcp?.path, `/root/${PI_MCP_FILE}`)
  assert.equal(JSON.parse(String(mcp?.content)).mcpServers.stamp.exposure, 'direct')
  assert.match(spawned[0] ?? '', / --no-extensions -e builtin:mcp /)
})

test("a dashed server's tools are named with its configured name, not pi's mcp__my_docs__", async () => {
  const { parts } = await oneTurn({ 'my-docs': { command: 'node', args: ['docs.mjs'] } }, [
    JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'mcp__my_docs__latest_version', arguments: {} },
      },
    }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } }),
    JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'mcp__my_docs__latest_version',
      result: { content: [{ type: 'text', text: '4.2.0' }] },
    }),
    JSON.stringify({ type: 'agent_end' }),
  ])
  assert.deepEqual(
    parts.flatMap((p) => (p.type === 'tool-call' || p.type === 'tool-result' ? [p.toolName] : [])),
    ['mcp__my-docs__latest_version', 'mcp__my-docs__latest_version'],
  )
})

test('a session without MCP servers writes no mcp.json and loads no extension', async () => {
  const { writes, spawned } = await oneTurn()
  assert.equal(
    writes.some((w) => w.path.endsWith('mcp.json')),
    false,
  )
  assert.doesNotMatch(spawned[0] ?? '', /-e builtin:mcp/)
})

test("auth is an environment with the provider's key, or it throws", () => {
  assert.throws(
    () => createPi({ auth: {}, provider: GOOGLE }),
    /pi auth must be an environment object with GEMINI_API_KEY \(pi's google provider's key\)/,
  )
  assert.throws(() => createPi({ auth: { GEMINI_API_KEY: 'k' } }), /pi needs a provider/)
  assert.equal(createPi({ auth: { GEMINI_API_KEY: 'AIza-k' }, provider: GOOGLE }).harnessId, 'pi')
})

test("on a provider's own API, pi runs that provider on a placeholder of its own key, brokered to its hosts", async () => {
  for (const [id, key, brokered] of [
    ['anthropic', 'sk-ant-k', [['api.anthropic.com', { 'x-api-key': 'sk-ant-k' }]]],
    ['openai', 'sk-k', [['api.openai.com', { authorization: 'Bearer sk-k' }]]],
    ['xai', 'xai-k', [['api.x.ai', { authorization: 'Bearer xai-k' }]]],
    [
      'opencode',
      'oc-k',
      [
        ['opencode.ai', { 'x-api-key': 'oc-k' }],
        ['opencode.ai', { 'x-goog-api-key': 'oc-k' }],
        ['opencode.ai', { authorization: 'Bearer oc-k' }],
      ],
    ],
  ] as const) {
    const p = provider(id)
    const { spawned, envs, transformations } = await oneTurn(
      undefined,
      undefined,
      { auth: { [p.credentialEnv]: key }, provider: p },
      'm',
    )
    assert.match(spawned[0] ?? '', new RegExp(` --provider '${id}' --model 'm' `))
    const placeholder = envs[0]?.[p.credentialEnv] ?? ''
    assert.match(placeholder, /^aisdkhc_/)
    assert.deepEqual(Object.keys(envs[0] ?? {}).sort(), [p.credentialEnv, 'PI_OFFLINE'].sort())
    const seen = transformations as Array<{
      match: { host: string }
      transform: { headers: unknown }
    }>
    assert.deepEqual(
      seen.map((t) => [t.match.host, t.transform.headers]),
      brokered,
    )
  }
})

test("pi's providers come from its probed catalog: a refused one says why, an unknown one that pi reads no key for it", () => {
  assert.equal(PROBED_VERSION, PI_LOCKED_AI)
  assert.equal(provider('google').credentialEnv, 'GEMINI_API_KEY')
  assert.deepEqual(piProvider('azure'), {
    refused:
      "pi's azure provider can't run here: its host is your account's or resource's, which pi takes from more variables",
  })
  assert.match(String((piProvider('google-vertex') as { refused: string }).refused), /vertex\(\)/)
  assert.deepEqual(piProvider('nope'), { refused: 'pi has no provider "nope" that reads a key' })
})

test('on Vertex AI, pi runs its google-vertex provider on a credentials file, with no key', async () => {
  const vertex = { project: 'p', location: 'global', credentialsFile: '/reeval/adc.json' }
  const { spawned, envs } = await oneTurn(undefined, undefined, { auth: {}, vertex })
  assert.match(spawned[0] ?? '', / --provider 'google-vertex' /)
  assert.deepEqual(envs[0], {
    GOOGLE_CLOUD_PROJECT: 'p',
    GOOGLE_CLOUD_LOCATION: 'global',
    GOOGLE_APPLICATION_CREDENTIALS: '/reeval/adc.json',
    PI_OFFLINE: '1',
  })
})

test("on OpenRouter, a Gemini model runs on pi's own openrouter provider on a placeholder key, with no models.json", async () => {
  const { writes, spawned, envs } = await oneTurn(
    undefined,
    undefined,
    { auth: { OPENROUTER_API_KEY: 'sk-or-k' }, gateway: PI_OPENROUTER, effort: 'low' },
    'google/gemini-3.8-flash',
  )
  assert.match(
    spawned[0] ?? '',
    /^cd '\/w' && exec .* --provider 'openrouter' --model 'google\/gemini-3\.8-flash' --thinking 'low' /,
  )
  assert.doesNotMatch(spawned[0] ?? '', /gateway-models\.mjs/)
  assert.equal(
    writes.some((w) => w.path.endsWith('models.json')),
    false,
  )
  assert.equal(envs[0]?.PI_OFFLINE, '1')
  assert.notEqual(envs[0]?.OPENROUTER_API_KEY, 'sk-or-k')
  assert.ok(envs[0]?.OPENROUTER_API_KEY)
})

test("on a gateway, another provider's model runs on reeval's provider, its key brokered as a Bearer token and in x-api-key", async () => {
  const { writes, spawned, transformations } = await oneTurn(
    undefined,
    undefined,
    {
      auth: { OPENROUTER_API_KEY: 'sk-or-k' },
      gateway: PI_OPENROUTER,
      modelInfo: { reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100 },
    },
    'anthropic/claude-haiku-4.5',
  )
  assert.ok(writes.some((w) => w.path.endsWith('gateway-models.mjs')))
  assert.match(spawned[0] ?? '', /'node' '[^']*gateway-models\.mjs' .*"contextWindow":1000/)
  assert.match(
    spawned[0] ?? '',
    / --provider 'reeval-openrouter' --model 'anthropic\/claude-haiku-4\.5' /,
  )
  const brokered = transformations as Array<{ match: { host: string }; transform: unknown }>
  assert.deepEqual(
    brokered.map((t) => [t.match.host, t.transform]),
    [
      ['openrouter.ai', { headers: { authorization: 'Bearer sk-or-k' } }],
      ['openrouter.ai', { headers: { 'x-api-key': 'sk-or-k' } }],
    ],
  )
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createPi({
    auth: { GEMINI_API_KEY: 'AIza-k' },
    provider: GOOGLE,
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker GEMINI_API_KEY .* so the key stays out of it/,
  )
})

test('on a gateway, a turn writes models.json first and runs on its provider', () => {
  const command = buildPiCommand({
    cli: '/h/pi',
    workDir: '/w',
    promptFile: '/d/p.txt',
    model: 'google/gemini-3.8-flash',
    sessionId: 'abc',
    sessionDir: '/s',
    provider: 'reeval-ai-gateway',
    before: "node '/d/gateway-models.mjs'",
  })
  assert.match(
    command,
    /^cd '\/w' && node '\/d\/gateway-models\.mjs' && exec '\/h\/pi' .* --provider 'reeval-ai-gateway' --model 'google\/gemini-3\.8-flash' /,
  )
})

/** A bootstrap directory laid out as pnpm installs pi: pi-ai beside pi-coding-agent. */
function fakeBootstrap(catalogs: Record<string, Record<string, unknown>>) {
  const root = mkdtempSync(join(tmpdir(), 'pi-gateway-'))
  const store = join(root, 'node_modules/.pnpm/pi/node_modules/@earendil-works')
  mkdirSync(join(store, 'pi-coding-agent'), { recursive: true })
  mkdirSync(join(store, 'pi-ai/dist/providers/data'), { recursive: true })
  for (const [file, models] of Object.entries(catalogs)) {
    const chat = Object.fromEntries(Object.entries(models).map(([id, m]) => [`chat:${id}`, m]))
    writeFileSync(
      join(store, `pi-ai/dist/providers/data/${file}.json`),
      JSON.stringify({ 'some-api': chat }),
    )
  }
  mkdirSync(join(root, 'bootstrap/node_modules/@earendil-works'), { recursive: true })
  const link = join(root, 'bootstrap/node_modules/@earendil-works/pi-coding-agent')
  // A junction on Windows, where a plain symlink needs Developer Mode or admin.
  symlinkSync(join(store, 'pi-coding-agent'), link, 'junction')
  return { root, bootstrap: join(root, 'bootstrap') }
}

async function gatewayModels(
  bootstrap: string,
  out: string,
  model: string,
  gateway: PiGateway = PI_AI_GATEWAY,
  info: PiModelInfo | null = null,
) {
  const script = join(bootstrap, 'gateway-models.mjs')
  writeFileSync(script, await piGatewayModelsScript())
  return spawnSync(
    process.execPath,
    [script, bootstrap, out, JSON.stringify(gateway), model, JSON.stringify(info)],
    { encoding: 'utf8' },
  )
}

test("models.json: pi's catalog entry, each thinking level as Gemini's own under providerOptions", async () => {
  const { root, bootstrap } = fakeBootstrap({
    google: {
      'gemini-3.8-flash': {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
        input: ['text'],
        cost: { input: 1, output: 2 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    },
  })
  const out = join(root, 'agent/models.json')
  const r = await gatewayModels(bootstrap, out, 'google/gemini-3.8-flash')
  assert.equal(r.status, 0, r.stderr)
  const provider = JSON.parse(readFileSync(out, 'utf8')).providers['reeval-ai-gateway']
  assert.equal(provider.baseUrl, 'https://ai-gateway.vercel.sh/v1')
  assert.equal(provider.api, 'openai-completions')
  assert.equal(provider.apiKey, '$AI_GATEWAY_API_KEY')
  assert.equal(provider.compat.supportsReasoningEffort, false)
  const [model] = provider.models
  assert.equal(model.id, 'google/gemini-3.8-flash')
  assert.equal(model.maxTokens, 100)
  const low = { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } }
  assert.deepEqual(Object.keys(model.samplingParamsByThinkingLevel), ['low', 'medium', 'high'])
  assert.deepEqual(model.samplingParamsByThinkingLevel.low, {
    providerOptions: { google: low, vertex: low },
  })
})

test('twin: a Gemini model missing from the catalog, or on a thinking budget, is refused', async () => {
  const { root, bootstrap } = fakeBootstrap({
    google: { 'gemini-2.5-pro': { id: 'gemini-2.5-pro', reasoning: true } },
  })
  const out = join(root, 'agent/models.json')
  const missing = await gatewayModels(bootstrap, out, 'google/gemini-9')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /pi's catalog has no Gemini model gemini-9/)
  const budget = await gatewayModels(bootstrap, out, 'google/gemini-2.5-pro')
  assert.equal(budget.status, 1)
  assert.match(budget.stderr, /gemini-2\.5-pro takes a thinking budget, not a thinking level/)
})

const limits = (contextWindow: number) => ({
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens: 100,
})

test("models.json: an Anthropic model on the gateway's Messages API, any other on Chat Completions, from the gateway's catalog, then the provider's", async () => {
  const { root, bootstrap } = fakeBootstrap({
    openrouter: {
      'anthropic/claude-haiku-4.5': { id: 'anthropic/claude-haiku-4.5', ...limits(1) },
    },
    openai: { 'gpt-5.4-mini': { id: 'gpt-5.4-mini', ...limits(2) } },
    anthropic: { 'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', ...limits(3) } },
  })
  const out = join(root, 'agent/models.json')
  for (const [model, api, baseUrl, contextWindow] of [
    ['anthropic/claude-haiku-4.5', 'anthropic-messages', 'https://openrouter.ai/api', 1],
    ['openai/gpt-5.4-mini', 'openai-completions', 'https://openrouter.ai/api/v1', 2],
    ['anthropic/claude-sonnet-5.5', 'anthropic-messages', 'https://openrouter.ai/api', 3],
  ] as const) {
    const r = await gatewayModels(bootstrap, out, model, PI_OPENROUTER)
    assert.equal(r.status, 0, r.stderr)
    const provider = JSON.parse(readFileSync(out, 'utf8')).providers['reeval-openrouter']
    assert.deepEqual([provider.api, provider.baseUrl, provider.authHeader], [api, baseUrl, true])
    assert.equal(provider.apiKey, '$OPENROUTER_API_KEY')
    assert.equal(provider.compat.supportsReasoningEffort, undefined, model)
    const [entry] = provider.models
    assert.deepEqual([entry.id, entry.contextWindow, entry.reasoning], [model, contextWindow, true])
  }
})

test('twin: a model no catalog lists takes the limits it is given, and without them is refused', async () => {
  const { root, bootstrap } = fakeBootstrap({})
  const out = join(root, 'agent/models.json')
  const info = {
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 7,
    maxTokens: 5,
  } as const
  const given = await gatewayModels(bootstrap, out, 'mistral/devstral-2', PI_AI_GATEWAY, info)
  assert.equal(given.status, 0, given.stderr)
  const provider = JSON.parse(readFileSync(out, 'utf8')).providers['reeval-ai-gateway']
  assert.equal(provider.baseUrl, 'https://ai-gateway.vercel.sh/v1')
  assert.deepEqual(provider.models, [
    {
      id: 'mistral/devstral-2',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 7,
      maxTokens: 5,
    },
  ])
  const none = await gatewayModels(bootstrap, out, 'mistral/devstral-2')
  assert.equal(none.status, 1)
  assert.match(none.stderr, /neither pi's catalog nor models\.dev describes mistral\/devstral-2/)
})
