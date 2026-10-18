import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createFx,
  FX_CLI_SHA256,
  FX_CLI_VERSION,
  FX_INSTALL_COMMAND,
  FX_QUIET_ENV,
  fxEnv,
  fxProviderOf,
  fxSettings,
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
    FX_RELAY_UPSTREAM: 'https://api.openai.com',
  })
  assert.deepEqual(
    Object.keys(fxEnv('openai/gpt-5.6')).sort(),
    Object.keys(fxEnv('gpt-4.1')).sort(),
  )
  assert.deepEqual(fxSettings('openai/gpt-5.6'), [])
  const [file] = fxSettings('gpt-4.1-mini')
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
