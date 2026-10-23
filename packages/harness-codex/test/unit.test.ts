import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  CODEX_CLI_INTEGRITY,
  CODEX_CLI_VERSION,
  CODEX_INSTALL_COMMAND,
  getCodexBootstrap,
} from '../src/codex-bootstrap.ts'
import {
  AI_GATEWAY_PROVIDER,
  buildCodexCommand,
  buildCodexConfig,
  buildCodexMarketplace,
  buildCodexPluginAdd,
  CODEX_CREDENTIAL_ENV,
  createCodex,
} from '../src/codex-harness.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test("the bootstrap installs the pinned Codex build for the sandbox's arch, checked against npm's sha512", async () => {
  const b = await getCodexBootstrap()
  assert.deepEqual(b.commands, [{ command: CODEX_INSTALL_COMMAND }])
  for (const arch of ['x64', 'arm64'] as const) {
    assert.ok(CODEX_INSTALL_COMMAND.includes(`sri=${CODEX_CLI_INTEGRITY[arch]}`), arch)
    assert.match(CODEX_CLI_INTEGRITY[arch], /^sha512-[A-Za-z0-9+/]{86}==$/)
  }
  assert.ok(
    CODEX_INSTALL_COMMAND.includes(
      `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-$arch.tgz`,
    ),
  )
  assert.match(CODEX_INSTALL_COMMAND, /does not match its sha512/)
})

test('the first turn starts a thread; later ones resume it, the prompt from its file', () => {
  const base = {
    binDir: '/h/bin',
    workDir: '/reeval/workspace',
    promptFile: '/d/prompt-1.txt',
    model: 'gpt-5.4-mini',
  }
  assert.equal(
    buildCodexCommand({ ...base, threadId: undefined }),
    `cd '/reeval/workspace' && PATH='/h/bin':"$PATH" exec codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --model 'gpt-5.4-mini' -- "$(cat '/d/prompt-1.txt')" < /dev/null`,
  )
  assert.equal(
    buildCodexCommand({ ...base, threadId: 't-1' }),
    `cd '/reeval/workspace' && PATH='/h/bin':"$PATH" exec codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --model 'gpt-5.4-mini' resume 't-1' -- "$(cat '/d/prompt-1.txt')" < /dev/null`,
  )
})

test('effort is model_reasoning_effort in the config', () => {
  const config = buildCodexConfig({ effort: 'high' })
  assert.match(config, /"model_reasoning_effort" = "high"/)
  assert.doesNotMatch(buildCodexConfig({}), /model_reasoning_effort/)
})

test("the config turns off analytics and plugins, and uses reeval's HTTP provider on the key", () => {
  const config = buildCodexConfig({})
  assert.equal(
    config,
    [
      '"analytics" = { "enabled" = false }',
      '"features" = { "plugins" = false }',
      '"model_provider" = "openai-http"',
      '"model_providers" = { "openai-http" = { "name" = "OpenAI", "base_url" = "https://api.openai.com/v1", "env_key" = "OPENAI_API_KEY", "wire_api" = "responses", "supports_websockets" = false } }',
      '',
    ].join('\n'),
  )
})

test('a session with plugins turns plugins on, and nothing else', () => {
  assert.equal(
    buildCodexConfig({ plugins: true }),
    buildCodexConfig({}).replace('"plugins" = false', '"plugins" = true'),
  )
})

test('plugins are listed in the home marketplace by their path from home, then added from it', () => {
  const plugins = [{ name: 'probe', dir: '/home/reeval/.reeval/plugins/probe' }]
  assert.deepEqual(JSON.parse(buildCodexMarketplace(plugins, '/home/reeval')), {
    name: 'reeval',
    plugins: [{ name: 'probe', source: { source: 'local', path: './.reeval/plugins/probe' } }],
  })
  assert.throws(
    () => buildCodexMarketplace([{ name: 'x', dir: '/opt/x' }], '/home/reeval'),
    /the x plugin must be under \/home\/reeval \(it's at \/opt\/x\)/,
  )
  assert.equal(
    buildCodexPluginAdd('/h/bin', [...plugins, { name: 'review', dir: '/home/reeval/r' }]),
    `PATH='/h/bin':"$PATH" codex plugin add 'probe@reeval' < /dev/null && PATH='/h/bin':"$PATH" codex plugin add 'review@reeval' < /dev/null`,
  )
})

test('a session with plugins writes the marketplace and adds each before its first turn', async () => {
  const writes: Array<{ path: string; content: string }> = []
  const runs: string[] = []
  const harness = createCodex({
    auth: { [CODEX_CREDENTIAL_ENV]: 'sk-k' },
    plugins: [{ name: 'probe', dir: '/home/reeval/.reeval/plugins/probe' }],
  })
  const sandboxSession = (exitCode: number) => ({
    run: async ({ command }: { command: string }) => {
      runs.push(command)
      return command.includes('plugin add')
        ? { exitCode, stdout: '', stderr: exitCode ? 'no marketplace named reeval' : '' }
        : { exitCode: 0, stdout: '/home/reeval', stderr: '' }
    },
    writeTextFile: async (w: { path: string; content: string }) => void writes.push(w),
  })
  await harness.doStart({
    sessionId: 's1',
    sessionWorkDir: '/w',
    sandboxSession: sandboxSession(0),
  } as never)
  assert.deepEqual(
    writes.map((w) => w.path),
    ['/home/reeval/.codex/config.toml', '/home/reeval/.agents/plugins/marketplace.json'],
  )
  assert.match(writes[0]?.content ?? '', /"features" = \{ "plugins" = true \}/)
  assert.match(runs.at(-1) ?? '', /codex plugin add 'probe@reeval'/)
  await assert.rejects(
    harness.doStart({
      sessionId: 's2',
      sessionWorkDir: '/w',
      sandboxSession: sandboxSession(1),
    } as never),
    /codex plugin add failed \(exit 1\): no marketplace named reeval/,
  )
})

test('MCP servers are inline tables under mcp_servers, their strings JSON-quoted', () => {
  const config = buildCodexConfig({
    mcpServers: {
      stamp: { command: 'node', args: ['s "q".mjs'], env: { A: 'b\nc' } },
      web: { url: 'https://x.test/mcp', http_headers: { Authorization: 'Bearer t' } },
    },
  })
  assert.ok(
    config.includes(
      '"mcp_servers" = { "stamp" = { "command" = "node", "args" = ["s \\"q\\".mjs"], "env" = { "A" = "b\\nc" } }, "web" = { "url" = "https://x.test/mcp", "http_headers" = { "Authorization" = "Bearer t" } } }\n',
    ),
    config,
  )
  assert.doesNotMatch(buildCodexConfig({ mcpServers: {} }), /mcp_servers/)
})

test('auth is an environment with the OpenAI key, or it throws', () => {
  assert.throws(
    () => createCodex({ auth: {} }),
    /Codex auth must be an environment object with OPENAI_API_KEY/,
  )
  assert.equal(createCodex({ auth: { [CODEX_CREDENTIAL_ENV]: 'sk-k' } }).harnessId, 'codex')
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createCodex({
    auth: { [CODEX_CREDENTIAL_ENV]: 'sk-k' },
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker OPENAI_API_KEY .* so the key stays out of it/,
  )
})

test('a sandbox that brokers gets a placeholder, swapped for the key on the OpenAI API only', async () => {
  const rules: Array<{
    match: Record<string, unknown>
    transform: { headers: Record<string, string> }
  }> = []
  const writes: Array<{ path: string; content: string }> = []
  const harness = createCodex({ auth: { [CODEX_CREDENTIAL_ENV]: 'sk-real' } })
  const session = await harness.doStart({
    sessionId: 's1',
    sessionWorkDir: '/reeval/workspace',
    sandboxSession: {
      addRequestTransformations: async (r: typeof rules) => void rules.push(...r),
      run: async () => ({ exitCode: 0, stdout: '/home/reeval', stderr: '' }),
      writeTextFile: async (w: { path: string; content: string }) => void writes.push(w),
    },
  } as never)
  assert.equal(session.sessionId, 's1')
  assert.equal(rules.length, 1)
  const [rule] = rules
  assert.equal(rule?.match.host, 'api.openai.com')
  assert.equal(rule?.transform.headers.Authorization, 'Bearer sk-real')
  const placeholder = JSON.stringify(rule?.match.headers)
  assert.doesNotMatch(placeholder, /sk-real/)
  assert.deepEqual(
    writes.map((w) => w.path),
    ['/home/reeval/.codex/config.toml'],
  )
  assert.doesNotMatch(writes[0]?.content ?? '', /sk-real/)
})

test("a session counts each turn's tokens once, its running total kept in the resume state", async () => {
  const fixture = (n: number) =>
    readFileSync(new URL(`./fixtures/three-turns-${n}.ndjson`, import.meta.url), 'utf8')
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    })
  const harness = createCodex({ auth: { [CODEX_CREDENTIAL_ENV]: 'sk-k' } })
  const sandboxSession = (turns: number[]) => ({
    run: async () => ({ exitCode: 0, stdout: '/home/reeval', stderr: '' }),
    writeTextFile: async () => {},
    readTextFile: async () => null,
    spawn: async () => ({
      stdout: stream(fixture(turns.shift() ?? 0)),
      stderr: stream(''),
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    }),
  })
  const input = async (session: Awaited<ReturnType<typeof harness.doStart>>) => {
    const parts: Array<{ type: string; totalUsage?: { inputTokens: { total?: number } } }> = []
    const control = await session.doPromptTurn({
      prompt: 'p',
      skills: [],
      tools: [],
      emit: (p: never) => parts.push(p),
    } as never)
    await control.done
    return parts.find((p) => p.type === 'finish')?.totalUsage?.inputTokens.total
  }
  const first = await harness.doStart({
    sessionId: 's1',
    sessionWorkDir: '/reeval/workspace',
    sandboxSession: sandboxSession([1, 2]),
  } as never)
  // OpenAI's input_tokens for each turn's calls; Codex reports 52174, 105616, 159437.
  assert.equal(await input(first), 52174)
  assert.equal(await input(first), 53442)
  const state = await first.doDetach()
  assert.deepEqual(state.data, {
    threadId: '01a16552-5bb9-72f1-a22f-039ede6d699e',
    usage: {
      input_tokens: 105616,
      cached_input_tokens: 78803,
      cache_write_input_tokens: 26798,
      output_tokens: 441,
      reasoning_output_tokens: 146,
    },
  })
  const resumed = await harness.doStart({
    sessionId: 's1',
    sessionWorkDir: '/reeval/workspace',
    sandboxSession: sandboxSession([3]),
    resumeFrom: state,
  } as never)
  assert.equal(await input(resumed), 53821)
})

test('on Vercel AI Gateway, Codex calls its Responses API with the gateway key, brokered there only', async () => {
  const config = buildCodexConfig({ provider: AI_GATEWAY_PROVIDER })
  assert.match(config, /"base_url" = "https:\/\/ai-gateway\.vercel\.sh\/v1"/)
  assert.match(config, /"env_key" = "AI_GATEWAY_API_KEY"/)
  assert.throws(
    () => createCodex({ auth: { [CODEX_CREDENTIAL_ENV]: 'sk-k' }, provider: AI_GATEWAY_PROVIDER }),
    /Codex auth must be an environment object with AI_GATEWAY_API_KEY \(a Vercel AI Gateway key\)/,
  )
  const rules: Array<{
    match: Record<string, unknown>
    transform: { headers: Record<string, string> }
  }> = []
  const writes: Array<{ path: string; content: string }> = []
  const harness = createCodex({
    auth: { AI_GATEWAY_API_KEY: 'vck-real' },
    provider: AI_GATEWAY_PROVIDER,
  })
  await harness.doStart({
    sessionId: 's1',
    sessionWorkDir: '/reeval/workspace',
    sandboxSession: {
      addRequestTransformations: async (r: typeof rules) => void rules.push(...r),
      run: async () => ({ exitCode: 0, stdout: '/home/reeval', stderr: '' }),
      writeTextFile: async (w: { path: string; content: string }) => void writes.push(w),
    },
  } as never)
  assert.equal(rules[0]?.match.host, 'ai-gateway.vercel.sh')
  assert.equal(rules[0]?.transform.headers.Authorization, 'Bearer vck-real')
  assert.doesNotMatch(writes[0]?.content ?? '', /vck-real/)
  assert.match(writes[0]?.content ?? '', /ai-gateway\.vercel\.sh/)
})
