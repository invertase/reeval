import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness'
import { isSandboxCredentialPlaceholder } from '@ai-sdk/harness/utils'
import { createAntigravity } from '../src/index.ts'
import { fakeSandbox, fixture, runTurn, visible } from './support.ts'

const KEY = 'AIza-test-key-never-in-the-sandbox'

const start = async (
  sandbox: ReturnType<typeof fakeSandbox>,
  settings: Parameters<typeof createAntigravity>[0] = {},
  extra: Record<string, unknown> = {},
) =>
  createAntigravity({ auth: { GEMINI_API_KEY: KEY }, ...settings }).doStart({
    sessionId: 's1',
    sandboxSession: sandbox as never,
    sessionWorkDir: '/reeval/workspace',
    permissionMode: 'allow-all',
    ...extra,
  })

const result = (conversationId: string, response = 'ok') =>
  `${JSON.stringify({
    event: 'result',
    result: { conversation_id: conversationId, status: 'SUCCESS', response },
  })}\n`

describe('createAntigravity', () => {
  let warn: typeof console.warn
  let warnings: string[]
  beforeEach(() => {
    warn = console.warn
    warnings = []
    console.warn = (message: string) => void warnings.push(message)
  })
  afterEach(() => {
    console.warn = warn
  })

  test('the adapter shape', () => {
    const harness = createAntigravity()
    assert.equal(harness.specificationVersion, 'harness-v1')
    assert.equal(harness.harnessId, 'antigravity')
    assert.equal(harness.supportsBuiltinToolApprovals, undefined)
    assert.equal(typeof harness.getBootstrap, 'function')
  })

  test('brokering: the sandbox gets a placeholder, the rule holds the key', async () => {
    const sandbox = fakeSandbox({ turns: [{ stdout: fixture('write-and-run.ndjson') }] })
    const session = await start(sandbox)
    const parts = await runTurn(session, 'go', { model: 'gemini-3.8-flash-low' })
    const [spawned] = sandbox.spawned
    assert.ok(spawned)
    const placeholder = spawned.env.GEMINI_API_KEY ?? ''
    assert.ok(isSandboxCredentialPlaceholder(placeholder), 'a placeholder, not the key')
    assert.equal(spawned.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true', "'1' doesn't turn it off")
    const everything = JSON.stringify([...sandbox.spawned, ...sandbox.files])
    assert.ok(!everything.includes(KEY), 'the key never reaches the sandbox')
    assert.equal(sandbox.transformations.length, 1)
    assert.deepEqual(sandbox.transformations[0]?.match.headers, [
      { key: { exact: 'x-goog-api-key' }, value: { exact: placeholder } },
    ])
    assert.deepEqual(sandbox.transformations[0]?.transform.headers, { 'x-goog-api-key': KEY })
    assert.equal(spawned.workingDirectory, '/reeval/workspace')
    assert.match(spawned.command, /'--model' 'gemini-3\.8-flash-low'/)
    assert.match(spawned.command, /--dangerously-skip-permissions/)
    assert.equal(visible(parts).at(-1)?.type, 'finish')
  })

  test('fail-closed: requireCredentialBrokering refuses a sandbox that cannot broker', async () => {
    const sandbox = fakeSandbox({ broker: false })
    await assert.rejects(
      start(sandbox, { requireCredentialBrokering: true }),
      /can't broker GEMINI_API_KEY .*the key stays out of it/,
    )
    assert.equal(sandbox.spawned.length, 0)
    assert.equal(sandbox.files.size, 0)
  })

  test('without brokering or the requirement, the key is forwarded with a warning', async () => {
    const sandbox = fakeSandbox({ broker: false, turns: [{ stdout: result('c') }] })
    const session = await start(sandbox)
    await runTurn(session, 'go')
    assert.equal(sandbox.spawned[0]?.env.GEMINI_API_KEY, KEY)
    assert.match(warnings.join('\n'), /credential brokering does not work/)
  })

  test('on Vertex: ADC mode on the project and region, no key read or brokered', async () => {
    const sandbox = fakeSandbox({ turns: [{ stdout: result('c') }] })
    const session = await createAntigravity({
      auth: {},
      vertex: { project: 'p-1', location: 'global', credentialsFile: '/reeval/adc.json' },
    }).doStart({
      sessionId: 's1',
      sandboxSession: sandbox as never,
      sessionWorkDir: '/reeval/workspace',
      permissionMode: 'allow-all',
    })
    await runTurn(session, 'go')
    const env = sandbox.spawned[0]?.env ?? {}
    assert.equal(env.AGY_ADC_AUTH, '1')
    assert.equal(env.GOOGLE_CLOUD_PROJECT, 'p-1')
    assert.equal(env.GOOGLE_CLOUD_LOCATION, 'global')
    assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/reeval/adc.json')
    assert.equal(env.GEMINI_API_KEY, undefined)
    assert.equal(sandbox.transformations.length, 0)
    // The CLI refuses ADC mode while settings.json names the Gemini provider.
    assert.deepEqual(
      JSON.parse(sandbox.files.get('/root/.gemini/antigravity-cli/settings.json') ?? ''),
      { enableTelemetry: false },
    )
  })

  test('settings pin the Gemini provider and turn telemetry off; MCP servers get their own file', async () => {
    const sandbox = fakeSandbox({})
    await start(sandbox, {
      settings: { modelProvider: 'oauth', colorScheme: 'dark' },
      mcpServers: { docs: { serverUrl: 'https://mcp.example/sse', headers: { A: 'b' } } },
    })
    assert.deepEqual(
      JSON.parse(sandbox.files.get('/root/.gemini/antigravity-cli/settings.json') ?? ''),
      { enableTelemetry: false, colorScheme: 'dark', modelProvider: 'gemini' },
    )
    assert.deepEqual(JSON.parse(sandbox.files.get('/root/.gemini/config/mcp_config.json') ?? ''), {
      mcpServers: { docs: { serverUrl: 'https://mcp.example/sse', headers: { A: 'b' } } },
    })
  })

  test('plugins are installed with agy plugin install, their hooks written as agy reads them', async () => {
    const sandbox = fakeSandbox({})
    const claude = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `${'$'}{CLAUDE_PLUGIN_ROOT}/start.sh` }] },
        ],
      },
    }
    // A byte-order mark, as editors on Windows may save it, is no part of the JSON.
    sandbox.files.set(
      '/root/.reeval/plugins/house/hooks/hooks.json',
      `\uFEFF${JSON.stringify(claude)}`,
    )
    await start(sandbox, {
      plugins: [
        { name: 'house', dir: '/root/.reeval/plugins/house' },
        { name: 'lite', dir: '/root/.reeval/plugins/lite' },
      ],
    })
    assert.deepEqual(
      sandbox.spawned.map((s) => /'[^']*agy' plugin install '([^']*)'/.exec(s.command)?.[1]),
      ['/root/.reeval/plugins/house', '/root/.reeval/plugins/lite'],
    )
    assert.deepEqual(
      JSON.parse(sandbox.files.get('/root/.gemini/config/plugins/house/hooks.json') ?? ''),
      {
        house: {
          SessionStart: [
            { type: 'command', command: '/root/.gemini/config/plugins/house/start.sh' },
          ],
        },
      },
    )
    assert.equal(sandbox.files.has('/root/.gemini/config/plugins/lite/hooks.json'), false)
  })

  test('a plugin agy refuses to install fails the session start, with what it said', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: '', stderr: 'invalid plugin manifest\n', exitCode: 1 }],
    })
    await assert.rejects(
      start(sandbox, { plugins: [{ name: 'house', dir: '/root/.reeval/plugins/house' }] }),
      /agy plugin install \/root\/\.reeval\/plugins\/house exited 1: invalid plugin manifest$/,
    )
  })

  test('skills go to ~/.gemini/config/skills and instructions to ~/.gemini/GEMINI.md', async () => {
    const sandbox = fakeSandbox({ turns: [{ stdout: result('c') }] })
    const session = await start(sandbox)
    await runTurn(session, 'go', {
      skills: [{ name: 'house-greeting', description: 'Greets.', content: 'Say hi.' }],
      instructions: 'Answer tersely.',
    })
    const skill = sandbox.files.get('/root/.gemini/config/skills/house-greeting/SKILL.md')
    assert.match(skill ?? '', /^---\n[\s\S]*name: house-greeting[\s\S]*---\n+Say hi\./)
    assert.equal(sandbox.files.get('/root/.gemini/GEMINI.md'), 'Answer tersely.\n')
  })

  test('the prompt is a file, and the next turn resumes the conversation', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: result('conv-1') }, { stdout: result('conv-1') }],
    })
    const session = await start(sandbox)
    await runTurn(session, "it's `$(rm -rf /)` safe")
    await runTurn(session, 'again')
    const prompts = [...sandbox.files].filter(([path]) => path.includes('/prompt-'))
    assert.deepEqual(
      prompts.map(([, content]) => content),
      ["it's `$(rm -rf /)` safe", 'again'],
    )
    assert.doesNotMatch(sandbox.spawned[0]?.command ?? '', /--conversation/)
    assert.match(sandbox.spawned[1]?.command ?? '', /'--conversation' 'conv-1'/)
  })

  test('detach returns the conversation, and a new session resumes it', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: result('conv-9') }, { stdout: result('conv-9') }],
    })
    const first = await start(sandbox)
    await runTurn(first, 'one')
    const state = await first.doDetach()
    assert.deepEqual(state, {
      type: 'resume-session',
      harnessId: 'antigravity',
      specificationVersion: 'harness-v1',
      data: { conversationId: 'conv-9' },
    })
    const second = await start(sandbox, {}, { resumeFrom: state })
    assert.equal(second.isResume, true)
    await runTurn(second, 'two')
    assert.match(sandbox.spawned[1]?.command ?? '', /'--conversation' 'conv-9'/)
  })

  test('a JSON response format passes its schema file', async () => {
    const sandbox = fakeSandbox({ turns: [{ stdout: result('c') }] })
    const session = await start(sandbox)
    await runTurn(session, 'go', {
      responseFormat: { type: 'json', schema: { type: 'object', properties: {} } },
    })
    assert.match(sandbox.spawned[0]?.command ?? '', /'--json-schema' '[^']+schema-1\.json'/)
  })

  test('a JSON schema whose root is not an object is unsupported, before the CLI starts', async () => {
    for (const schema of [
      { type: 'array', items: { type: 'string' } },
      { type: 'string' },
      { anyOf: [{ type: 'object' }, { type: 'null' }] },
    ]) {
      const sandbox = fakeSandbox({ turns: [{ stdout: result('c') }] })
      const session = await start(sandbox)
      await assert.rejects(
        runTurn(session, 'go', { responseFormat: { type: 'json', schema } }),
        (e) =>
          HarnessCapabilityUnsupportedError.isInstance(e) &&
          /root is "type": "object"/.test((e as Error).message),
      )
      assert.equal(sandbox.spawned.length, 0)
    }
  })

  test('a JSON response format without a schema passes no --json-schema', async () => {
    const sandbox = fakeSandbox({ turns: [{ stdout: result('c') }] })
    await runTurn(await start(sandbox), 'go', { responseFormat: { type: 'json' } })
    assert.doesNotMatch(sandbox.spawned[0]?.command ?? '', /--json-schema/)
  })

  test('host tools, image prompts and compaction are unsupported, not ignored', async () => {
    const session = await start(fakeSandbox({}))
    await assert.rejects(
      session.doPromptTurn({
        prompt: 'x',
        skills: [],
        tools: [{ name: 't', inputSchema: {} }],
        emit: () => {},
      } as never),
      (e) => HarnessCapabilityUnsupportedError.isInstance(e),
    )
    await assert.rejects(
      runTurn(session, undefined as never, {
        prompt: { role: 'user', content: [{ type: 'image', image: 'x' }] },
      }),
      /text prompts only/,
    )
    await assert.rejects(Promise.resolve(session.doCompact()), (e) =>
      HarnessCapabilityUnsupportedError.isInstance(e),
    )
  })

  test('stdout split mid-line and mid-character, with no final newline, still parses', async () => {
    const bytes = new TextEncoder().encode(result('c', 'café').trimEnd())
    const cut = bytes.indexOf(0xc3) + 1
    const sandbox = fakeSandbox({
      turns: [{ stdout: [bytes.slice(0, 7), bytes.slice(7, cut), bytes.slice(cut)] }],
    })
    const parts = visible(await runTurn(await start(sandbox), 'go'))
    const text = parts.find((p) => p.type === 'text-delta')
    assert.equal(text?.type === 'text-delta' && text.delta, 'café')
    assert.equal(parts.at(-1)?.type === 'finish' && parts.at(-1)?.finishReason.unified, 'stop')
  })

  test('a CLI that dies without a result still finishes the turn', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: '', stderr: 'error: authentication required', exitCode: 1 }],
    })
    const session = await start(sandbox)
    const parts = visible(await runTurn(session, 'go'))
    assert.deepEqual(
      parts.map((p) => p.type),
      ['stream-start', 'error', 'finish'],
    )
  })
})
