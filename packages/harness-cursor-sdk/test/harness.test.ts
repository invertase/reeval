import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness'
import { isSandboxCredentialPlaceholder } from '@ai-sdk/harness/utils'
import { createCursorSdk } from '../src/index.ts'
import { fakeSandbox, fixture, runTurn, visible } from './support.ts'

const KEY = 'key_test-never-in-the-sandbox'
const CATALOG = [{ id: 'composer-2.5', aliases: ['composer'] }, { id: 'gpt-5.2' }]

const start = async (
  sandbox: ReturnType<typeof fakeSandbox>,
  settings: Parameters<typeof createCursorSdk>[0] = {},
  extra: Record<string, unknown> = {},
) =>
  createCursorSdk({ auth: { CURSOR_API_KEY: KEY }, modelCatalog: CATALOG, ...settings }).doStart({
    sessionId: 's1',
    sandboxSession: sandbox as never,
    sessionWorkDir: '/reeval/workspace',
    permissionMode: 'allow-all',
    ...extra,
  })

const turnConfig = (sandbox: ReturnType<typeof fakeSandbox>, n: number) =>
  JSON.parse(sandbox.files.get(`/root/.ai-sdk-harness/.agent-runs/s1/turn-${n}.json`) ?? 'null')

describe('createCursorSdk', () => {
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
    const harness = createCursorSdk()
    assert.equal(harness.specificationVersion, 'harness-v1')
    assert.equal(harness.harnessId, 'cursor-sdk')
    assert.equal(typeof harness.getBootstrap, 'function')
  })

  test('brokering: the sandbox gets a placeholder and the model catalog, never the key', async () => {
    const sandbox = fakeSandbox({ turns: [{ stdout: fixture('tools-mcp-skills.ndjson') }] })
    const session = await start(sandbox, { modelParams: { fast: 'false' } })
    const parts = await runTurn(session, 'go', { model: 'composer-2.5' })
    const [spawned] = sandbox.spawned
    assert.ok(spawned)
    const placeholder = spawned.env.CURSOR_API_KEY ?? ''
    assert.ok(isSandboxCredentialPlaceholder(placeholder), 'a placeholder, not the key')
    assert.deepEqual(JSON.parse(spawned.env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON ?? '[]'), [
      CATALOG[0],
    ])
    const everything = JSON.stringify([...sandbox.spawned, ...sandbox.files])
    assert.ok(!everything.includes(KEY), 'the key never reaches the sandbox')
    assert.equal(sandbox.transformations.length, 1)
    assert.equal(spawned.workingDirectory, '/reeval/workspace')
    assert.match(
      spawned.command,
      /^exec node '\/root\/\.ai-sdk-harness\/\.harness-bootstrap\/cursor-sdk\/runner\.mjs' '/,
    )
    const config = turnConfig(sandbox, 1)
    assert.deepEqual(config.model, { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] })
    assert.deepEqual(config.settingSources, ['project', 'user'])
    assert.equal(config.agentId, undefined)
    assert.equal(visible(parts).at(-1)?.type, 'finish')
  })

  test("unset model parameters are sent explicitly, from the catalog's default variant, Fast off", async () => {
    // As Cursor's catalog lists composer-2.5: the first allowed value is false, the default is true.
    const catalog = [
      {
        id: 'composer-2.5',
        parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
        variants: [
          { params: [{ id: 'fast', value: 'true' }], displayName: 'Composer 2.5', isDefault: true },
          { params: [{ id: 'fast', value: 'false' }], displayName: 'Composer 2.5' },
        ],
      },
      {
        id: 'grok-4.7',
        parameters: [
          { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] },
          { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
        ],
        variants: [
          {
            params: [
              { id: 'reasoning_effort', value: 'high' },
              { id: 'fast', value: 'true' },
            ],
            isDefault: true,
          },
        ],
      },
      {
        id: 'fast-only',
        parameters: [{ id: 'fast', values: [{ value: 'true' }] }],
        variants: [{ params: [{ id: 'fast', value: 'true' }], isDefault: true }],
      },
      { id: 'no-variants', parameters: [{ id: 'fast', values: [{ value: 'false' }] }] },
      { id: 'gpt-5.2' },
    ]
    const model = async (settings: Parameters<typeof createCursorSdk>[0], id = 'composer-2.5') => {
      const sandbox = fakeSandbox({ turns: [{ stdout: fixture('tools-mcp-skills.ndjson') }] })
      const session = await start(sandbox, { modelCatalog: catalog, ...settings })
      await runTurn(session, 'go', { model: id })
      return turnConfig(sandbox, 1).model
    }
    assert.deepEqual(await model({}), {
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'false' }],
    })
    assert.deepEqual(await model({ modelParams: { fast: 'true' } }), {
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'true' }],
    })
    assert.deepEqual(await model({}, 'grok-4.7'), {
      id: 'grok-4.7',
      params: [
        { id: 'reasoning_effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    })
    assert.deepEqual(
      await model({}, 'fast-only'),
      { id: 'fast-only', params: [{ id: 'fast', value: 'true' }] },
      'a model with no standard speed keeps its only value',
    )
    assert.deepEqual(await model({}, 'no-variants'), {
      id: 'no-variants',
      params: [{ id: 'fast', value: 'false' }],
    })
    assert.deepEqual(await model({}, 'gpt-5.2'), { id: 'gpt-5.2' }, 'no variants, no params')
  })

  test('effort maps onto the catalog param, not Fast', async () => {
    const catalog = [
      {
        id: 'grok-4.7',
        parameters: [
          { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] },
          { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
        ],
        variants: [
          {
            params: [
              { id: 'reasoning_effort', value: 'high' },
              { id: 'fast', value: 'true' },
            ],
            isDefault: true,
          },
        ],
      },
      {
        id: 'composer-2.5',
        parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
        variants: [{ params: [{ id: 'fast', value: 'true' }], isDefault: true }],
      },
    ]
    const model = async (settings: Parameters<typeof createCursorSdk>[0], id: string) => {
      const sandbox = fakeSandbox({ turns: [{ stdout: fixture('tools-mcp-skills.ndjson') }] })
      const session = await start(sandbox, { modelCatalog: catalog, ...settings })
      await runTurn(session, 'go', { model: id })
      return turnConfig(sandbox, 1).model
    }
    assert.deepEqual(await model({ effort: 'low', modelParams: { fast: 'true' } }, 'grok-4.7'), {
      id: 'grok-4.7',
      params: [
        { id: 'fast', value: 'true' },
        { id: 'reasoning_effort', value: 'low' },
      ],
    })
    await assert.rejects(
      model({ effort: 'high' }, 'composer-2.5'),
      /no effort parameter for composer-2.5.*Fast is params\.fast/,
    )
  })

  test('fail-closed: requireCredentialBrokering refuses a sandbox that cannot broker', async () => {
    const sandbox = fakeSandbox({ broker: false })
    await assert.rejects(
      start(sandbox, { requireCredentialBrokering: true }),
      /can't broker CURSOR_API_KEY .*the key stays out of it/,
    )
    assert.equal(sandbox.spawned.length, 0)
  })

  test('without brokering it warns and forwards the key, as the AI SDK adapters do', async () => {
    const sandbox = fakeSandbox({ broker: false, turns: [{ stdout: fixture('resume.ndjson') }] })
    const session = await start(sandbox)
    await runTurn(session, 'go', { model: 'composer-2.5' })
    assert.equal(sandbox.spawned[0]?.env.CURSOR_API_KEY, KEY)
    assert.ok(warnings.length > 0)
  })

  test('one runner serves every turn: a follow-up starts no new process', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: fixture('tools-mcp-skills.ndjson') }, { stdout: fixture('resume.ndjson') }],
    })
    const session = await start(sandbox)
    const first = await runTurn(session, 'one', { model: 'composer-2.5' })
    const second = await runTurn(session, 'two', { model: 'composer-2.5' })
    assert.equal(sandbox.spawned.length, 1)
    assert.match(
      sandbox.spawned[0]?.command ?? '',
      /'\/root\/\.ai-sdk-harness\/\.agent-runs\/s1' 1$/,
    )
    for (const parts of [first, second]) {
      assert.equal(visible(parts).at(-1)?.type, 'finish')
      assert.ok(!visible(parts).some((p) => p.type === 'error'))
    }
    assert.ok(sandbox.files.has('/root/.ai-sdk-harness/.agent-runs/s1/turn-2.ready'))
    const stopped = await session.doStop()
    assert.deepEqual(stopped.data, { agentId: 'agent-922f53b4-2f6c-4f26-9507-5878e7749f8f' })
  })

  test('after the runner exits, the next turn starts one that resumes the agent', async () => {
    const sandbox = fakeSandbox({
      turns: [
        { stdout: fixture('tools-mcp-skills.ndjson'), exit: true },
        { stdout: fixture('resume.ndjson') },
      ],
    })
    const session = await start(sandbox)
    await runTurn(session, 'one', { model: 'composer-2.5' })
    const second = visible(await runTurn(session, 'two', { model: 'composer-2.5' }))
    assert.ok(!second.some((p) => p.type === 'error'))
    assert.equal(sandbox.spawned.length, 2)
    assert.match(sandbox.spawned[1]?.command ?? '', / 2$/, 'the new runner starts at turn 2')
    assert.equal(turnConfig(sandbox, 2).agentId, 'agent-922f53b4-2f6c-4f26-9507-5878e7749f8f')
  })

  test('a runner that dies mid-turn fails it with its stderr; the next turn starts anew', async () => {
    const sandbox = fakeSandbox({
      turns: [
        { stdout: '', stderr: 'Segmentation fault', exitCode: 139, exit: true },
        { stdout: fixture('resume.ndjson') },
      ],
    })
    const session = await start(sandbox)
    const crashed = visible(await runTurn(session, 'one', { model: 'composer-2.5' }))
    const error = crashed.find((p) => p.type === 'error') as { error: Error } | undefined
    assert.match(String(error?.error), /exited with code 139.*Segmentation fault/)
    await runTurn(session, 'two', { model: 'composer-2.5' })
    assert.equal(sandbox.spawned.length, 2)
  })

  test('an abort kills the runner; the next turn starts a new one', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: fixture('resume.ndjson') }, { stdout: fixture('resume.ndjson') }],
    })
    const session = await start(sandbox)
    const aborted = new AbortController()
    aborted.abort()
    const parts = visible(
      await runTurn(session, 'one', { model: 'composer-2.5', abortSignal: aborted.signal }),
    )
    assert.equal(parts.at(-1)?.type, 'finish')
    assert.ok(!parts.some((p) => p.type === 'error'), 'an abort is not an error')
    await runTurn(session, 'two', { model: 'composer-2.5' })
    assert.equal(sandbox.spawned.length, 2)
  })

  test('skills go to ~/.agents/skills, instructions into the prompt, MCP servers inline', async () => {
    const sandbox = fakeSandbox({ turns: [{ stdout: fixture('resume.ndjson') }] })
    const mcpServers = { codes: { type: 'stdio', command: 'node', args: ['codes.mjs'] } }
    const session = await start(sandbox, { mcpServers })
    await runTurn(session, 'the task', {
      model: 'composer-2.5',
      instructions: 'Be brief.',
      skills: [{ name: 'greet', description: 'Greets.', content: 'Say hi.' }],
    })
    assert.ok([...sandbox.files.keys()].some((k) => k.startsWith('/root/.agents/skills/greet/')))
    const prompt = sandbox.files.get('/root/.ai-sdk-harness/.agent-runs/s1/prompt-1.txt') ?? ''
    assert.match(prompt, /<instructions>\nBe brief\.\n<\/instructions>/)
    assert.match(prompt, /the task$/)
    assert.deepEqual(turnConfig(sandbox, 1).mcpServers, mcpServers)
  })

  test('host tools, structured output and image prompts are unsupported', async () => {
    const sandbox = fakeSandbox({})
    const session = await start(sandbox)
    await assert.rejects(
      runTurn(session, 'x', { tools: [{ name: 't' }] }),
      HarnessCapabilityUnsupportedError,
    )
    await assert.rejects(
      runTurn(session, 'x', { responseFormat: { type: 'json' } }),
      HarnessCapabilityUnsupportedError,
    )
  })
})
