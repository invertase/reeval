import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  FX_RELAY_USAGE_FILE,
  FxUsageLedger,
  fxEnv,
  fxProviderOf,
  fxSession,
  fxSettings,
  fxVertexBaseUrl,
  withSandboxEnv,
} from '../src/fx-harness.ts'
import { FxStreamTranslator, fxCallsSplit, fxMcpSegment, withUsageSplit } from '../src/fx-stream.ts'
import { VERSION } from '../src/version.ts'

/** Runs the script's sha256 check on a file, with its digest and with another. */
function assertChecksSha256(script: string, file: string) {
  assert.doesNotMatch(script, /sha256sum/)
  const line = script.split('\n').find((l) => l.startsWith('node -e') && l.includes(file))
  assert.ok(line, `no Node check of ${file}`)
  const dir = mkdtempSync(join(tmpdir(), 'sha256-'))
  writeFileSync(join(dir, file), 'archive')
  const check = (sha: string) =>
    spawnSync('bash', ['-c', `sha=${sha}; ${line}`], { cwd: dir, encoding: 'utf8' })
  assert.equal(check(createHash('sha256').update('archive').digest('hex')).status, 0)
  const wrong = check('0'.repeat(64))
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, new RegExp(`${file.replaceAll('.', '\\.')} does not match its sha256`))
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the install downloads the pinned release and checks its sha256 on both arches', () => {
  assert.ok(FX_INSTALL_COMMAND.includes(`/download/v${FX_CLI_VERSION}/fx-$build.tar.gz`))
  for (const sha of Object.values(FX_CLI_SHA256)) {
    assert.match(sha, /^[0-9a-f]{64}$/)
    assert.ok(FX_INSTALL_COMMAND.includes(`sha=${sha}`))
  }
  assertChecksSha256(FX_INSTALL_COMMAND, 'fx.tar.gz')
})

test('each OS and arch picks its own build and checksum, and any other is refused', () => {
  const picks = FX_INSTALL_COMMAND.slice(
    FX_INSTALL_COMMAND.indexOf('case '),
    FX_INSTALL_COMMAND.indexOf('esac') + 4,
  )
  const pick = (os: string, arch: string) => {
    const bin = mkdtempSync(join(tmpdir(), 'uname-'))
    writeFileSync(join(bin, 'uname'), `#!/bin/sh\n[ "$1" = -s ] && echo ${os} || echo ${arch}\n`)
    chmodSync(join(bin, 'uname'), 0o755)
    return spawnSync('bash', ['-c', `${picks}\necho "$build $sha"`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })
  }
  const sha = FX_CLI_SHA256
  assert.equal(pick('Linux', 'x86_64').stdout, `linux-x86_64 ${sha.x86_64}\n`)
  assert.equal(pick('Linux', 'aarch64').stdout, `linux-aarch64 ${sha.aarch64}\n`)
  assert.equal(pick('Darwin', 'arm64').stdout, `macos-aarch64 ${sha['darwin-aarch64']}\n`)
  const intel = pick('Darwin', 'x86_64')
  assert.equal(intel.status, 1)
  assert.equal(intel.stderr, 'reeval runs fx on macOS on Apple Silicon only, not x86_64\n')
  const riscv = pick('Linux', 'riscv64')
  assert.equal(riscv.status, 1)
  assert.equal(riscv.stderr, 'fx has no release for Linux riscv64\n')
})

test('a gateway id runs on AI Gateway, a bare id on OpenAI', () => {
  assert.equal(fxProviderOf('anthropic/claude-sonnet-5'), 'gateway')
  assert.equal(fxProviderOf('gpt-4.1-mini'), 'openai')
  assert.deepEqual(fxEnv('gpt-4.1-mini'), {
    ...FX_QUIET_ENV,
    FX_PROVIDER: 'openai',
    FX_MODEL: 'gpt-4.1-mini',
    FX_GATEWAY_BASE_URL: 'http://127.0.0.1:24823',
    FX_GATEWAY_CHAT_URL: 'http://127.0.0.1:24823/v4/ai/language-model',
    FX_RELAY_UPSTREAM: 'https://api.openai.com',
    FX_RELAY_EFFORT: '',
    FX_RELAY_USAGE: FX_RELAY_USAGE_FILE,
  })
  assert.equal(fxEnv('openai/gpt-5.6').FX_RELAY_USAGE, FX_RELAY_USAGE_FILE)
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
    'http://127.0.0.1:24823/v1',
  )
})

test('on OpenRouter, an OpenRouter id runs on its Chat Completions API through the relay', () => {
  assert.deepEqual(fxEnv('openai/gpt-5-mini', { provider: 'openrouter' }), {
    ...FX_QUIET_ENV,
    FX_PROVIDER: 'openrouter',
    FX_MODEL: 'openai/gpt-5-mini',
    FX_GATEWAY_BASE_URL: 'http://127.0.0.1:24823',
    FX_GATEWAY_CHAT_URL: 'http://127.0.0.1:24823/v4/ai/language-model',
    FX_RELAY_UPSTREAM: 'https://openrouter.ai',
    FX_RELAY_EFFORT: '',
    FX_RELAY_USAGE: FX_RELAY_USAGE_FILE,
  })
  const [file] = fxSettings('openai/gpt-5-mini', { provider: 'openrouter' })
  assert.deepEqual(JSON.parse(file?.content ?? ''), {
    session_titles: false,
    providers: {
      openrouter: {
        protocol: 'openai-chat-completions',
        base_url: 'http://127.0.0.1:24823/api/v1',
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
  assert.equal(env.FX_RELAY_EFFORT, 'low')
  assert.equal(env.FX_RELAY_USAGE, FX_RELAY_USAGE_FILE)
  assert.equal(
    fxEnv('m', { vertex: { project: 'p', location: 'us-east5' } }).FX_RELAY_UPSTREAM,
    'https://us-east5-aiplatform.googleapis.com',
  )
  assert.deepEqual(Object.keys(env).sort(), Object.keys(fxEnv('gpt-4.1')).sort())
  const [file] = fxSettings('google/gemini-3.8-flash', { vertex })
  assert.deepEqual(JSON.parse(file?.content ?? '').providers, {
    vertex: {
      protocol: 'openai-chat-completions',
      base_url: 'http://127.0.0.1:24823/v1/projects/p-1/locations/global/endpoints/openapi',
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
  const { port: upstreamPort } = server.address() as AddressInfo
  const relay = spawn(
    process.execPath,
    [join(dir, 'relay.mjs'), '0', `http://127.0.0.1:${upstreamPort}`, ready],
    { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' },
  )
  let exited = false
  relay.on('exit', () => {
    exited = true
  })
  try {
    // Port 0 so nothing else can hold the relay's port; the relay writes the one it bound.
    let port = ''
    while (!port) {
      if (exited) throw new Error('the relay exited before it listened')
      if (existsSync(ready)) port = readFileSync(ready, 'utf8')
      if (!port) await sleep(10)
    }
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

test('the relay makes a stream with thought signatures one fx reads, and gives them back', async () => {
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
    {},
    async (url, requests) => {
      const post = (messages: unknown[]) =>
        fetch(`${url}/v1/projects/p/locations/global/endpoints/openapi/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({ model: 'google/gemini-3.8-flash', messages }),
        }).then((r) => r.text())
      const other = { ...call, id: 'call_unseen' }
      const before = JSON.stringify({
        model: 'google/gemini-3.8-flash',
        messages: [{ role: 'assistant', tool_calls: [other] }],
      })
      await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: before }).then((r) =>
        r.text(),
      )
      assert.equal(requests.shift(), before, 'no signature seen yet, so none is added')
      const [first, last] = events(await post([{ role: 'user', content: 'hi' }]))
      assert.equal(first.choices[0].delta.tool_calls[0].index, 0)
      assert.equal(last.choices[0].finish_reason, 'tool_calls')
      assert.deepEqual(last.usage, {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 40 },
      })
      await post([{ role: 'assistant', tool_calls: [call, other] }])
      const sent = JSON.parse(requests[1] ?? '')
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

test('without FX_RELAY_EFFORT the relay passes a call and a stream fx reads as they are', async () => {
  const stream = sse(
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f' } }],
          },
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  )
  await withRelay(
    () => stream,
    { FX_RELAY_EFFORT: '' },
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

test("with FX_RELAY_USAGE the relay logs each call's last usage, and passes the stream as it is", async () => {
  const usage = {
    prompt_tokens: 5935,
    completion_tokens: 111,
    prompt_tokens_details: { cached_tokens: 4736 },
    completion_tokens_details: { reasoning_tokens: 30 },
  }
  const stream = sse(
    { choices: [{ index: 0, delta: { content: 'hi' } }], usage: null },
    { choices: [], usage },
  )
  const log = join(mkdtempSync(join(tmpdir(), 'fx-usage-')), 'usage.ndjson')
  await withRelay(
    () => stream,
    { FX_RELAY_USAGE: log },
    async (url) => {
      const post = () =>
        fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{}' }).then((r) => r.text())
      assert.equal(await post(), stream)
      // The line is written before the stream's end reaches fx.
      assert.deepEqual(
        readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
        [usage],
      )
      await post()
      assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 2)
      await fetch(`${url}/v1/models`).then((r) => r.text())
      assert.equal(
        readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
        2,
        'only model calls',
      )
    },
  )
})

test('the relay logs the usage fx reads, with thinking tokens only total_tokens counted', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'fx-usage-')), 'usage.ndjson')
  await withRelay(
    // No [DONE]: the stream's end logs it.
    () =>
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 150 } })}\n\n`,
    { FX_RELAY_USAGE: log },
    async (url) => {
      await fetch(`${url}/v1/projects/p/locations/global/endpoints/openapi/chat/completions`, {
        method: 'POST',
        body: '{}',
      }).then((r) => r.text())
      assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 40 },
      })
    },
  )
})

test('the relay keeps a character its request splits across chunks whole, and adds the effort', async () => {
  await withRelay(
    () => sse({ choices: [] }),
    { FX_RELAY_EFFORT: 'low' },
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
      assert.equal(JSON.parse(requests[0] ?? '').reasoning_effort, 'low')
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

test("a stdio MCP server's env lists the sandbox's variables under its own, and an HTTP one is as it was", () => {
  const sandbox = {
    PATH: '/usr/bin',
    HOME: '/home/reeval',
    USER: 'reeval',
    PWD: '/workspace',
    SHLVL: '1',
    _: '/usr/bin/node',
    REEVAL_EXEC_ID: 'abc-1',
    HTTPS_PROXY: 'http://127.0.0.1:41000',
    https_proxy: 'http://127.0.0.1:41000',
    NODE_EXTRA_CA_CERTS: '/reeval/ca.pem',
    NODE_USE_ENV_PROXY: '1',
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
    PROBE_WORD: 'eval-value',
    API_TOKEN: 'reeval-placeholder-1',
  }
  const http = { type: 'http', url: 'https://mcp.example/', headers: [] }
  const servers = withSandboxEnv(
    {
      probe: {
        command: '/usr/bin/env',
        args: ['node', 'probe.mjs'],
        env: [{ name: 'PROBE_WORD', value: 'own-value' }],
      },
      bare: { command: '/usr/bin/node', args: [] },
      http,
    },
    sandbox,
  )
  const inherited = [
    { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:41000' },
    { name: 'https_proxy', value: 'http://127.0.0.1:41000' },
    { name: 'NODE_EXTRA_CA_CERTS', value: '/reeval/ca.pem' },
    { name: 'NODE_USE_ENV_PROXY', value: '1' },
    { name: 'SSL_CERT_FILE', value: '/etc/ssl/certs/ca-certificates.crt' },
  ]
  assert.deepEqual(servers.probe, {
    command: '/usr/bin/env',
    args: ['node', 'probe.mjs'],
    env: [
      ...inherited,
      { name: 'API_TOKEN', value: 'reeval-placeholder-1' },
      { name: 'PROBE_WORD', value: 'own-value' },
    ],
  })
  assert.deepEqual(servers.bare, {
    command: '/usr/bin/node',
    args: [],
    env: [
      ...inherited,
      { name: 'PROBE_WORD', value: 'eval-value' },
      { name: 'API_TOKEN', value: 'reeval-placeholder-1' },
    ],
  })
  assert.equal(servers.http, http)
})

test("doStart reads the sandbox's environment for a stdio MCP server, and only then", async () => {
  const commands: string[] = []
  const sandbox = {
    run: async ({ command }: { command: string }) => {
      commands.push(command)
      return { exitCode: 1, stdout: '', stderr: 'no node' }
    },
  }
  const start = (mcpServers: Record<string, Record<string, unknown>>) =>
    createFx({ auth: { OPENAI_API_KEY: 'k' }, model: 'gpt-4.1', mcpServers }).doStart({
      sandboxSession: sandbox,
    } as never)
  await assert.rejects(
    start({ probe: { command: '/usr/bin/node', args: [], env: [] } }),
    /Couldn't read the sandbox's environment for fx's stdio MCP servers \(exit 1\): no node/,
  )
  assert.deepEqual(commands, [`node -e 'process.stdout.write(JSON.stringify(process.env))'`])
  commands.length = 0
  await start({ http: { type: 'http', url: 'https://mcp.example/', headers: [] } }).catch(() => {})
  assert.ok(!commands.some((c) => c.includes('process.env')), JSON.stringify(commands))
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

test("the turn's finish usage counts fx's cacheReadTokens and cacheWriteTokens, which ACP names cachedReadTokens and cachedWriteTokens", () => {
  const t = new FxStreamTranslator()
  const usage = { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 700, cacheWriteTokens: 100 }
  t.push({ type: 'raw', rawValue: { stopReason: 'end_turn', usage } })
  assert.deepEqual(
    t.push({
      type: 'finish',
      totalUsage: { inputTokens: { total: 1000 }, outputTokens: { total: 50 } },
    }),
    {
      type: 'finish',
      totalUsage: {
        inputTokens: { total: 1000, noCache: 200, cacheRead: 700, cacheWrite: 100 },
        outputTokens: { total: 50 },
      },
    },
  )
})

const call = (prompt: number, completion: number, cached?: number, reasoning?: number) =>
  JSON.stringify({
    prompt_tokens: prompt,
    completion_tokens: completion,
    ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
    ...(reasoning === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: reasoning } }),
  })

test("a turn's split is its calls' cached and reasoning tokens, when they sum to fx's totals", () => {
  const calls = [call(100, 10, 60, 4), call(200, 20, 150, 0)]
  assert.deepEqual(fxCallsSplit(calls, 300, 30), {
    cacheRead: 210,
    cacheWrite: undefined,
    reasoning: 4,
  })
  assert.deepEqual(
    fxCallsSplit([call(1, 1), ...calls, 'not json'], 300, 30),
    {
      cacheRead: 210,
      cacheWrite: undefined,
      reasoning: 4,
    },
    'a leftover call before the turn is skipped',
  )
  assert.deepEqual(
    fxCallsSplit([call(5, 5)], 5, 5),
    {
      cacheRead: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
    },
    'a provider that counts neither',
  )
  assert.equal(fxCallsSplit(calls, 301, 30), undefined)
  assert.equal(fxCallsSplit(calls.slice(1), 300, 30), undefined)
  assert.equal(fxCallsSplit([], 0, 0), undefined)
})

test("the ledger splits each turn from the calls logged since the last, and holds the turn's finish", async () => {
  let log = [call(7, 7)]
  const sandbox = { readTextFile: async () => log.join('\n') }
  const ledger = await FxUsageLedger.open(sandbox)
  assert.ok(ledger)
  const finish = (input: number, output: number) => ({
    type: 'finish',
    totalUsage: { inputTokens: { total: input }, outputTokens: { total: output } },
  })
  log = [...log, call(100, 10, 60, 4)]
  assert.deepEqual(await ledger.settle(finish(100, 10)), {
    type: 'finish',
    totalUsage: {
      inputTokens: { total: 100, noCache: 40, cacheRead: 60, cacheWrite: undefined },
      outputTokens: { total: 10, reasoning: 4 },
    },
  })
  log = [...log, call(50, 5, 0, 0)]
  assert.deepEqual((await ledger.settle(finish(50, 5))).totalUsage, {
    inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: 5, reasoning: 0 },
  })
  assert.deepEqual(await ledger.settle(finish(9, 9)), finish(9, 9), 'nothing logged')
  assert.equal(await FxUsageLedger.open({}), undefined)
  const failing = await FxUsageLedger.open({
    readTextFile: () => Promise.reject(new Error('gone')),
  })
  assert.deepEqual(await failing?.settle(finish(1, 1)), finish(1, 1))
  assert.deepEqual(withUsageSplit(finish(1, 1), {}, true), finish(1, 1))
})

test("on a Chat Completions provider, a turn's finish goes out once the ledger has split it, before the turn is done", async () => {
  const log = [call(100, 10, 60, 4)]
  const emitted: Array<{ type: string; totalUsage?: unknown }> = []
  let end = () => {}
  // As harness-acp's turn: it returns the turn's control at once, and `done` settles at its end.
  const session = {
    doPromptTurn: async ({ emit }: { emit: (part: unknown) => void }) => {
      const done = new Promise<void>((resolve) => {
        end = () => {
          emit({ type: 'text-delta', delta: 'hi' })
          emit({
            type: 'finish',
            totalUsage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
          })
          resolve()
        }
      })
      return {
        done,
        submit: function (this: unknown) {
          return this
        },
      }
    },
  }
  let reads = 0
  const ledger = await FxUsageLedger.open({
    readTextFile: async ({ path }) => {
      assert.equal(path, FX_RELAY_USAGE_FILE)
      return reads++ === 0 ? null : log.join('\n')
    },
  })
  const started = fxSession(session as never, [], ledger) as unknown as {
    doPromptTurn: (o: unknown) => Promise<{ done: Promise<void>; submit: () => unknown }>
  }
  const control = await started.doPromptTurn({ emit: (p: never) => emitted.push(p) })
  assert.deepEqual(emitted, [], 'the turn is still running')
  assert.ok(control.submit(), "the control's methods still work")
  end()
  await control.done
  assert.deepEqual(
    emitted.map((p) => p.type),
    ['text-delta', 'finish'],
  )
  assert.deepEqual(emitted[1]?.totalUsage, {
    inputTokens: { total: 100, noCache: 40, cacheRead: 60, cacheWrite: undefined },
    outputTokens: { total: 10, reasoning: 4 },
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
