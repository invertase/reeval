import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createFx,
  FX_CLI_SHA256,
  FX_CLI_VERSION,
  FX_INSTALL_COMMAND,
  FX_QUIET_ENV,
  fxEnv,
  fxProviderOf,
  fxSettings,
  fxVertexBaseUrl,
} from '../src/fx-harness.ts'
import { FxStreamTranslator, fxMcpSegment } from '../src/fx-stream.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the install downloads the pinned release and checks its sha256 on both arches', () => {
  assert.ok(FX_INSTALL_COMMAND.includes(`/download/v${FX_CLI_VERSION}/fx-linux-$arch.tar.gz`))
  for (const sha of Object.values(FX_CLI_SHA256)) {
    assert.match(sha, /^[0-9a-f]{64}$/)
    assert.ok(FX_INSTALL_COMMAND.includes(`sha=${sha}`))
  }
  assert.ok(FX_INSTALL_COMMAND.includes('sha256sum -c'))
})

test('a gateway id runs on AI Gateway, a bare id on OpenAI', () => {
  assert.equal(fxProviderOf('anthropic/claude-sonnet-5'), 'gateway')
  assert.equal(fxProviderOf('gpt-4.1-mini'), 'openai')
  assert.deepEqual(fxEnv('gpt-4.1-mini'), {
    ...FX_QUIET_ENV,
    FX_PROVIDER: 'openai',
    FX_MODEL: 'gpt-4.1-mini',
    FX_GATEWAY_BASE_URL: 'http://127.0.0.1:47823',
    FX_GATEWAY_CHAT_URL: 'http://127.0.0.1:47823/v4/ai/language-model',
    FX_RELAY_UPSTREAM: 'https://api.openai.com',
    FX_RELAY_GOOGLE: '',
    FX_RELAY_EFFORT: '',
  })
  assert.deepEqual(
    Object.keys(fxEnv('openai/gpt-5.6')).sort(),
    Object.keys(fxEnv('gpt-4.1')).sort(),
  )
  assert.deepEqual(fxSettings('openai/gpt-5.6'), [
    { path: '.fx/settings.json', content: '{\n  "session_titles": false\n}\n' },
  ])
  const [file] = fxSettings('gpt-4.1-mini')
  assert.equal(JSON.parse(file?.content ?? '').session_titles, false)
  assert.equal(file?.path, '.fx/settings.json')
  assert.deepEqual(JSON.parse(file?.content ?? '').providers.openai.auth, {
    type: 'bearer',
    env: 'OPENAI_API_KEY',
  })
  assert.equal(
    JSON.parse(file?.content ?? '').providers.openai.base_url,
    'http://127.0.0.1:47823/v1',
  )
})

test('on OpenRouter, an OpenRouter id runs on its Chat Completions API through the relay', () => {
  assert.deepEqual(fxEnv('openai/gpt-5-mini', { provider: 'openrouter' }), {
    ...FX_QUIET_ENV,
    FX_PROVIDER: 'openrouter',
    FX_MODEL: 'openai/gpt-5-mini',
    FX_GATEWAY_BASE_URL: 'http://127.0.0.1:47823',
    FX_GATEWAY_CHAT_URL: 'http://127.0.0.1:47823/v4/ai/language-model',
    FX_RELAY_UPSTREAM: 'https://openrouter.ai',
    FX_RELAY_GOOGLE: '',
    FX_RELAY_EFFORT: '',
  })
  const [file] = fxSettings('openai/gpt-5-mini', { provider: 'openrouter' })
  assert.deepEqual(JSON.parse(file?.content ?? ''), {
    session_titles: false,
    providers: {
      openrouter: {
        protocol: 'openai-chat-completions',
        base_url: 'http://127.0.0.1:47823/api/v1',
        auth: { type: 'bearer', env: 'OPENROUTER_API_KEY' },
      },
    },
  })
  assert.throws(
    () =>
      createFx({
        auth: { AI_GATEWAY_API_KEY: 'k' },
        model: 'openai/gpt-5-mini',
        provider: 'openrouter',
      }),
    /fx auth must be an environment object with OPENROUTER_API_KEY for openai\/gpt-5-mini/,
  )
  assert.equal(
    createFx({
      auth: { OPENROUTER_API_KEY: 'k' },
      model: 'openai/gpt-5-mini',
      provider: 'openrouter',
    }).harnessId,
    'fx',
  )
})

test("on Vertex AI, fx calls the relay's copy of the Chat Completions endpoint with no auth", () => {
  const vertex = { project: 'p-1', location: 'global' }
  const env = fxEnv('google/gemini-3.8-flash', { vertex, effort: 'low' })
  assert.equal(env.FX_PROVIDER, 'vertex')
  assert.equal(env.FX_RELAY_UPSTREAM, 'https://aiplatform.googleapis.com')
  assert.equal(env.FX_RELAY_GOOGLE, '1')
  assert.equal(env.FX_RELAY_EFFORT, 'low')
  assert.equal(
    fxEnv('m', { vertex: { project: 'p', location: 'us-east5' } }).FX_RELAY_UPSTREAM,
    'https://us-east5-aiplatform.googleapis.com',
  )
  assert.deepEqual(Object.keys(env).sort(), Object.keys(fxEnv('gpt-4.1')).sort())
  const [file] = fxSettings('google/gemini-3.8-flash', { vertex })
  assert.deepEqual(JSON.parse(file?.content ?? '').providers, {
    vertex: {
      protocol: 'openai-chat-completions',
      base_url: 'http://127.0.0.1:47823/v1/projects/p-1/locations/global/endpoints/openapi',
      auth: { type: 'none' },
    },
  })
  assert.equal(fxVertexBaseUrl(vertex), JSON.parse(file?.content ?? '').providers.vertex.base_url)
  assert.equal(createFx({ auth: {}, model: 'google/gemini-3.8-flash', vertex }).harnessId, 'fx')
})

/** The relay script the install writes, as it lands in the sandbox. */
const relayScript = () => {
  const start = FX_INSTALL_COMMAND.indexOf("<<'FX_RELAY'\n") + "<<'FX_RELAY'\n".length
  return FX_INSTALL_COMMAND.slice(start, FX_INSTALL_COMMAND.indexOf('FX_RELAY\ncat >', start))
}

const body = async (req: IncomingMessage) => {
  const pieces: Buffer[] = []
  for await (const piece of req) pieces.push(piece)
  return Buffer.concat(pieces).toString('utf8')
}

/** Starts the relay in front of `upstream` with `env`, and stops it after `run`. */
async function withRelay(
  upstream: (req: IncomingMessage, text: string) => string,
  env: Record<string, string>,
  run: (url: string, requests: string[]) => Promise<void>,
) {
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    const text = await body(req)
    requests.push(text)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const out = upstream(req, text)
    // In two writes split inside a chunk, as a stream arrives.
    res.write(out.slice(0, 40))
    res.end(out.slice(40))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const dir = mkdtempSync(join(tmpdir(), 'fx-relay-'))
  writeFileSync(join(dir, 'relay.mjs'), relayScript())
  const ready = join(dir, 'ready')
  const port = 40000 + Math.floor(Math.random() * 20000)
  const { port: upstreamPort } = server.address() as AddressInfo
  const relay = spawn(
    process.execPath,
    [join(dir, 'relay.mjs'), String(port), `http://127.0.0.1:${upstreamPort}`, ready],
    { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' },
  )
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++) await sleep(20)
    await run(`http://127.0.0.1:${port}`, requests)
  } finally {
    relay.kill()
    server.close()
  }
}

const sse = (...chunks: unknown[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
const events = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)))

test("the relay makes Google's Chat Completions stream one fx reads, and gives back its signatures", async () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }
  const stream = sse(
    {
      model: 'google/gemini-3.8-flash',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ ...call, extra_content: { google: { thought_signature: 'sig-1' } } }],
          },
        },
      ],
    },
    {
      model: 'google/gemini-3.8-flash',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 150 },
    },
  )
  await withRelay(
    () => stream,
    { FX_RELAY_GOOGLE: '1', FX_RELAY_EFFORT: 'low' },
    async (url, requests) => {
      const post = (messages: unknown[]) =>
        fetch(`${url}/v1/projects/p/locations/global/endpoints/openapi/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({ model: 'google/gemini-3.8-flash', messages }),
        }).then((r) => r.text())
      const [first, last] = events(await post([{ role: 'user', content: 'hi' }]))
      assert.equal(first.choices[0].delta.tool_calls[0].index, 0)
      assert.equal(last.choices[0].finish_reason, 'tool_calls')
      assert.deepEqual(last.usage, {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 40 },
      })
      const other = { ...call, id: 'call_unseen' }
      await post([{ role: 'assistant', tool_calls: [call, other] }])
      const sent = JSON.parse(requests[1] ?? '')
      assert.equal(sent.reasoning_effort, 'low')
      assert.deepEqual(
        sent.messages[0].tool_calls.map(
          (c: { extra_content: { google: { thought_signature: string } } }) =>
            c.extra_content.google.thought_signature,
        ),
        ['sig-1', 'skip_thought_signature_validator'],
      )
    },
  )
})

test('without FX_RELAY_GOOGLE or FX_RELAY_EFFORT the relay passes calls through as they are', async () => {
  const stream = sse({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 5 },
  })
  await withRelay(
    () => stream,
    { FX_RELAY_GOOGLE: '', FX_RELAY_EFFORT: '' },
    async (url, requests) => {
      const sent = JSON.stringify({ model: 'gpt-5.5', messages: [] })
      const text = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: sent }).then(
        (r) => r.text(),
      )
      assert.equal(text, stream)
      assert.equal(requests[0], sent)
    },
  )
})

test('the relay keeps a character its request splits across chunks whole', async () => {
  await withRelay(
    () => sse({ choices: [] }),
    { FX_RELAY_GOOGLE: '1' },
    async (url, requests) => {
      const content = 'héllo — 日本語 🎉'
      const sent = Buffer.from(
        JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] }),
      )
      const cut = sent.indexOf(Buffer.from('日')) + 1
      const halves = [sent.subarray(0, cut), sent.subarray(cut)]
      await fetch(`${url}/v1/projects/p/locations/global/endpoints/openapi/chat/completions`, {
        method: 'POST',
        body: new ReadableStream({
          async pull(controller) {
            const half = halves.shift()
            if (!half) return controller.close()
            controller.enqueue(half)
            await sleep(20)
          },
        }),
        duplex: 'half',
      } as RequestInit).then((r) => r.text())
      assert.equal(JSON.parse(requests[0] ?? '').messages[0].content, content)
    },
  )
})

test("auth is an environment with the model's provider's key, or it throws", () => {
  assert.throws(
    () => createFx({ auth: { OPENAI_API_KEY: 'k' }, model: 'openai/gpt-5.6' }),
    /fx auth must be an environment object with AI_GATEWAY_API_KEY for openai\/gpt-5.6/,
  )
  assert.equal(createFx({ auth: { OPENAI_API_KEY: 'k' }, model: 'gpt-4.1' }).harnessId, 'fx')
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createFx({
    auth: { AI_GATEWAY_API_KEY: 'k' },
    model: 'openai/gpt-5.6',
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker AI_GATEWAY_API_KEY .* so the key stays out of it/,
  )
})

test("MCP calls are renamed from fx's mcp_<server>_<tool>, longest server first", () => {
  assert.equal(fxMcpSegment('my.server'), 'my_server')
  const t = new FxStreamTranslator({ mcpServers: ['a', 'a_b'] })
  assert.deepEqual(t.push({ type: 'tool-call', toolName: 'mcp_a_b_stamp' }), {
    type: 'tool-call',
    toolName: 'mcp__a_b__stamp',
  })
  assert.deepEqual(t.push({ type: 'tool-result', toolName: 'mcp_a_x' }), {
    type: 'tool-result',
    toolName: 'mcp__a__x',
  })
  assert.deepEqual(t.push({ type: 'tool-call', toolName: 'bash' }), {
    type: 'tool-call',
    toolName: 'bash',
  })
})

test("the turn's finish usage counts fx's reasoningTokens, which ACP calls thoughtTokens", () => {
  const finish = {
    type: 'finish',
    totalUsage: {
      inputTokens: { total: 26447 },
      outputTokens: { total: 551, text: undefined, reasoning: undefined },
    },
  }
  assert.deepEqual(new FxStreamTranslator().push(finish), finish, 'nothing to add')
  const t = new FxStreamTranslator()
  const usage = { inputTokens: 26447, outputTokens: 551, reasoningTokens: 391 }
  t.push({ type: 'raw', rawValue: { stopReason: 'end_turn', usage } })
  assert.deepEqual(t.push(finish), {
    type: 'finish',
    totalUsage: {
      inputTokens: { total: 26447 },
      outputTokens: { total: 551, text: undefined, reasoning: 391 },
    },
  })
})

test("a command's result is its streamed output and exit code, not fx's clipped summary", () => {
  const t = new FxStreamTranslator()
  const update = (status: string, extra: Record<string, unknown>) =>
    t.push({
      type: 'raw',
      rawValue: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status, ...extra },
    })
  const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]
  update('in_progress', { content: text('contract-') })
  update('in_progress', { content: text('42\n') })
  update('completed', { content: text('{"session_id":null,"st'), command_result: { exit_code: 0 } })
  assert.deepEqual(
    t.push({ type: 'tool-result', toolCallId: 'c1', toolName: 'bash', result: text('{"s') }),
    {
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { output: 'contract-42\n', exitCode: 0 },
    },
  )
  const other = { type: 'tool-result', toolCallId: 'c2', toolName: 'bash', result: 'x' }
  assert.deepEqual(t.push(other), other)
})

test("a skill call's input gains the skill's name from its location", () => {
  const t = new FxStreamTranslator()
  const location = 'skill:61ce5ec8bc2106bf:0/contract-probe'
  assert.deepEqual(t.push({ type: 'tool-call', toolName: 'skill', input: { location } }), {
    type: 'tool-call',
    toolName: 'skill',
    input: { location, name: 'contract-probe' },
  })
  assert.deepEqual(
    t.push({ type: 'tool-call', toolName: 'skill', input: JSON.stringify({ location }) }),
    {
      type: 'tool-call',
      toolName: 'skill',
      input: JSON.stringify({ location, name: 'contract-probe' }),
    },
  )
  const unnamed = { type: 'tool-call', toolName: 'skill', input: { resource: '' } }
  assert.deepEqual(t.push(unnamed), unnamed)
})
