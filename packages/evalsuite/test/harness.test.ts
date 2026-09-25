import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness'
import { applyTransformations, hostAllowed, onEndpoint } from '@evalsuite/sandbox-docker'
import { missingCredentials, resolveConfig } from '../src/config.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { defineEnvironment, layered } from '../src/environment.ts'
import {
  AGENTS,
  type AgentKind,
  acpMcpServers,
  agentAuth,
  brokeringFor,
  claudeMcpServers,
  layoutOf,
} from '../src/harness/agents.ts'
import { workspaceSkillDir } from '../src/harness/index.ts'
import { normaliseStream } from '../src/harness/transcript.ts'
import { claudeCode, cursor, fakeHarness } from '../src/harness.ts'
import { harnessId } from '../src/options.ts'
import { imageHarness } from '../src/sandbox/prepare.ts'

describe('the Claude Code harness', () => {
  test('is plain data with its own cell id, and needs a model', () => {
    const h = claudeCode({ model: 'claude-opus-5-5' })
    assert.deepEqual(h, { kind: 'claude-code', model: 'claude-opus-5-5' })
    assert.deepEqual(JSON.parse(JSON.stringify(h)), h)
    assert.equal(harnessId(h), 'claude-code:claude-opus-5-5')
    assert.equal(
      harnessId(claudeCode({ model: 'anthropic/claude-opus-5-5' })),
      'claude-code:claude-opus-5-5',
    )
    assert.equal(harnessId(claudeCode({ model: 'opus', id: 'fast' })), 'fast')
    assert.equal(harnessId(cursor({ model: 'composer-2.5' })), 'cursor:composer-2.5')
    assert.throws(
      () => claudeCode({} as never),
      /claudeCode\(\) needs a model, e.g\. claudeCode\(\{ model: 'claude-sonnet-5' \}\)/,
    )
  })

  test('is accepted by the config and tells the CLI which key it needs', () => {
    const config = resolveConfig(
      { harness: [cursor(), claudeCode({ model: 'claude-opus-5-5' })] },
      '/p',
    )
    assert.deepEqual(
      config.harness.map((h) => h.kind),
      ['cursor', 'claude-code'],
    )
    assert.deepEqual(missingCredentials(config, {}), ['CURSOR_API_KEY', 'ANTHROPIC_API_KEY'])
    assert.deepEqual(
      missingCredentials(config, { CURSOR_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }),
      [],
    )
    assert.deepEqual(
      missingCredentials(config, { CURSOR_API_KEY: 'x' }, { harnessKinds: ['claude-code'] }),
      ['ANTHROPIC_API_KEY'],
    )
    assert.deepEqual(missingCredentials(config, {}, { harnessKinds: ['fake'] }), [])
  })

  test('reads rules from CLAUDE.md and repo skills from .claude/skills, in its own image', () => {
    const h = claudeCode({ model: 'claude-opus-5-5' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'CLAUDE.md',
      workspaceSkillDir: '.claude/skills',
      harnessSkillDir: '.claude/skills',
    })
    assert.equal(layoutOf(cursor()).rulesFile, 'AGENTS.md')
    assert.equal(workspaceSkillDir(cursor()), '.cursor/skills')
    assert.equal(workspaceSkillDir(fakeHarness()), '.agents/skills')
    assert.equal(imageHarness(h), 'claude-code')
    assert.equal(imageHarness(cursor()), 'cursor')
    assert.equal(imageHarness(fakeHarness()), 'cursor')
  })

  test("a fake agent with a layout is placed exactly like that agent, in that agent's image", () => {
    // The fixtures under test/features/harness/ run the fake agent with a layout, so this is
    // what makes them evidence for the real harnesses.
    for (const real of [claudeCode({ model: 'opus' }), cursor()]) {
      const fake = fakeHarness({ layout: real.kind })
      assert.deepEqual(layoutOf(fake), layoutOf(real), real.kind)
      assert.equal(imageHarness(fake), imageHarness(real), real.kind)
    }
    assert.throws(
      () => fakeHarness({ layout: 'codex' as never }),
      /fakeHarness\(\{ layout \}\) is one of 'cursor', 'claude-code' \(got "codex"\)/,
    )
  })

  test('one environment has one digest, whichever file its rules go to', async () => {
    const house = defineEnvironment('house', {
      rules: 'Always write tests.',
      files: { 'notes.txt': 'hi' },
    })
    const forFile = (file: string) =>
      resolveEnvironment(layered(undefined, house), {}, '/p', 'e', file)
    const claude = await forFile('CLAUDE.md')
    const composer = await forFile('AGENTS.md')
    const rulesAt = (r: Awaited<typeof claude>) =>
      r.files.filter((f) => f.content === 'Always write tests.').map((f) => f.path)
    assert.deepEqual(rulesAt(claude), ['CLAUDE.md'])
    assert.deepEqual(rulesAt(composer), ['AGENTS.md'])
    assert.deepEqual(
      claude.record.files.map((f) => f.path),
      ['notes.txt', 'CLAUDE.md'],
    )
    assert.equal(claude.record.digest, composer.record.digest)
    const edited = defineEnvironment('house', {
      rules: 'Never write tests.',
      files: { 'notes.txt': 'hi' },
    })
    const changed = await resolveEnvironment(layered(undefined, edited), {}, '/p', 'e', 'CLAUDE.md')
    assert.notEqual(changed.record.digest, claude.record.digest, 'the rules are in the digest')
  })

  test('rules win over a file at the same path', async () => {
    const env = defineEnvironment('both', {
      files: { 'CLAUDE.md': 'from files' },
      rules: 'from rules',
    })
    const r = await resolveEnvironment(layered(undefined, env), {}, '/p', 'e', 'CLAUDE.md')
    assert.equal(r.files.findLast((f) => f.path === 'CLAUDE.md')?.content, 'from rules')
  })

  test('gets MCP servers in the .mcp.json shape', () => {
    assert.deepEqual(
      claudeMcpServers({
        files: { transport: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: {
          transport: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer t' },
        },
      }),
      {
        files: { type: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer t' },
        },
      },
    )
  })
})

/** A sandbox session that records the adapter's request transformations, then stops the start. */
function recordingSession(): {
  session: HarnessV1NetworkSandboxSession
  rules: HarnessV1RequestTransformation[]
} {
  const rules: HarnessV1RequestTransformation[] = []
  const stop = () => Promise.reject(new Error('stopped by the test'))
  const session: HarnessV1NetworkSandboxSession = {
    id: 'test',
    description: 'recording session',
    defaultWorkingDirectory: '/es',
    ports: [43210],
    getPortEndpoint: stop,
    getPortUrl: stop,
    stop: async () => {},
    destroy: async () => {},
    readFile: stop,
    readBinaryFile: stop,
    readTextFile: stop,
    writeFile: stop,
    writeBinaryFile: stop,
    writeTextFile: stop,
    spawn: stop,
    run: stop,
    restricted: () => session,
    addRequestTransformations: async (added) => {
      rules.push(...added)
      throw new Error('stopped by the test')
    },
  }
  return { session, rules }
}

const HOST_CREDENTIALS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AI_GATEWAY_API_KEY',
  'CURSOR_API_KEY',
]

/**
 * The rules an agent's real adapter asks the sandbox for, given the auth ES passes it, while the
 * host has `env` set (which the adapter must not read).
 */
async function adapterRules(kind: AgentKind, env: Record<string, string>) {
  const saved = { ...process.env }
  for (const name of HOST_CREDENTIALS) delete process.env[name]
  Object.assign(process.env, env)
  try {
    const agent = AGENTS[kind]
    const adapter = await agent.adapter({ auth: agentAuth(agent) })
    const { session, rules } = recordingSession()
    await assert.rejects(
      adapter.doStart({ sessionId: 's', sandboxSession: session }),
      /stopped by the test/,
    )
    return rules
  } finally {
    for (const name of HOST_CREDENTIALS) delete process.env[name]
    Object.assign(process.env, saved)
  }
}

describe('credential brokering per agent', () => {
  const REAL = 'sk-ant-real-key-for-tests'
  const everything = {
    ANTHROPIC_API_KEY: REAL,
    ANTHROPIC_AUTH_TOKEN: 'host-token',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
    AI_GATEWAY_API_KEY: 'host-gateway',
  }

  test("Claude Code's adapter brokers only the API key to Anthropic, whatever else the host has", async () => {
    const rules = await adapterRules('claude-code', everything)
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.match.host, 'api.anthropic.com', 'never the AI Gateway')
    assert.deepEqual(rules[0]?.transform.headers, { 'x-api-key': REAL })
  })

  test("the key is swapped in on Claude Code's endpoints only; anything else is refused", async () => {
    const brokering = brokeringFor(claudeCode({ model: 'opus' }))
    assert.equal(brokering?.credential, 'ANTHROPIC_API_KEY')
    const rules = await adapterRules('claude-code', { ANTHROPIC_API_KEY: REAL })
    const placeholder = String(rules[0]?.match.headers?.[0]?.value?.exact ?? 'missing')
    assert.match(placeholder, /^aisdkhc_/)
    const send = (method: string, path: string) =>
      applyTransformations(
        rules,
        { host: 'api.anthropic.com', method, path, headers: { 'x-api-key': placeholder } },
        brokering?.endpoints,
      )
    for (const [method, path] of [
      ['POST', '/v1/messages?beta=true'],
      ['POST', '/v1/messages/count_tokens'],
      ['GET', '/api/claude_code/settings'],
      ['GET', '/api/claude_code/policy_limits'],
    ] as const) {
      assert.equal(send(method, path).headers['x-api-key'], REAL, `${method} ${path}`)
    }
    for (const [method, path] of [
      ['GET', '/v1/models'],
      ['POST', '/v1/files'],
      ['POST', '/v1/messages/batches'],
      ['GET', '/v1/messages'],
      ['POST', '/api/event_logging/v2/batch'],
      ['GET', '/api/claude_cli/bootstrap'],
      ['POST', '/api/eval/sdk-zAZezfDKGoZuXXKe'],
    ] as const) {
      const r = send(method, path)
      assert.equal(r.refused, true, `${method} ${path}`)
      assert.equal(r.headers['x-api-key'], placeholder, `${method} ${path}`)
    }
  })

  test("Cursor's adapter rule is on its one endpoint, whatever else the host has", async () => {
    const rules = await adapterRules('cursor', { ...everything, CURSOR_API_KEY: 'crsr_real' })
    assert.equal(rules.length, 1)
    const { endpoints } = brokeringFor(cursor()) ?? { endpoints: [] }
    const auth = String(rules[0]?.match.headers?.[0]?.value?.exact ?? '')
    const exchange = applyTransformations(
      rules,
      {
        host: 'api2.cursor.sh',
        method: 'POST',
        path: '/auth/exchange_user_api_key',
        headers: { authorization: auth },
      },
      endpoints,
    )
    assert.equal(exchange.headers.authorization, 'Bearer crsr_real')
  })

  test("Cursor's session tokens are tokenised at its exchange and swapped back on its hosts only", () => {
    const tokens = brokeringFor(cursor())?.tokens
    assert.equal(tokens?.name, 'CURSOR_API_KEY')
    assert.deepEqual(tokens?.fields, ['accessToken', 'refreshToken'])
    assert.ok(
      onEndpoint([tokens?.endpoint ?? { host: 'none' }], {
        host: 'api2.cursor.sh',
        method: 'POST',
        path: '/auth/exchange_user_api_key',
        headers: {},
      }),
    )
    const hosts = tokens?.hosts ?? []
    for (const host of ['api2.cursor.sh', 'agentn.global.api5.cursor.sh', 'cursor.sh']) {
      assert.ok(hostAllowed(hosts, host), host)
    }
    for (const host of ['cursor.sh.evil.test', 'api.anthropic.com']) {
      assert.ok(!hostAllowed(hosts, host), host)
    }
    assert.equal(brokeringFor(claudeCode({ model: 'opus' }))?.tokens, undefined)
  })

  test('with no credential set, the harness fails closed before the adapter starts', async () => {
    await assert.rejects(
      adapterRules('claude-code', { AI_GATEWAY_API_KEY: 'host-gateway' }),
      /ANTHROPIC_API_KEY isn't set, so the Claude Code harness can't authenticate/,
    )
  })
})

describe('Claude Code transcripts', () => {
  test('its Edit and Write tools are file edits, keyed by file_path', () => {
    const call = (id: string, toolName: string, input: unknown) => ({
      ms: 10,
      part: { type: 'tool-call', toolCallId: id, toolName, input },
    })
    const result = (id: string, output: unknown) => ({
      ms: 20,
      part: { type: 'tool-result', toolCallId: id, output },
    })
    const events = normaliseStream(
      [
        call('w', 'write', { file_path: '/es/workspace/greet.js', content: 'hi\n' }),
        result('w', 'ok'),
        call('e', 'edit', { file_path: 'greet.js', old_string: 'hi', new_string: 'hello' }),
        result('e', 'ok'),
        call('b', 'bash', { command: 'ls' }),
        result('b', 'greet.js'),
        { ms: 30, part: { type: 'error', error: { message: 'process exited with code 1' } } },
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) => [e.type, 'path' in e ? e.path : 'tool' in e ? e.tool : '']),
      [
        ['file-edit', '/es/workspace/greet.js'],
        ['file-edit', 'greet.js'],
        ['tool', 'bash'],
        ['error', ''],
      ],
    )
    assert.equal(
      events.at(-1)?.type === 'error' && events.at(-1)?.message,
      'process exited with code 1',
    )
  })

  const call = (id: string, toolName: string, input: unknown) => ({
    ms: 10,
    part: { type: 'tool-call', toolCallId: id, toolName, input },
  })
  const result = (id: string, output: unknown) => ({
    ms: 20,
    part: { type: 'tool-result', toolCallId: id, output },
  })

  test('its Write and Edit results say what changed and by how many lines', () => {
    const greet =
      'function greet(name) {\n  return "Hello, " + name;\n}\n\nmodule.exports = { greet };\n'
    const events = normaliseStream(
      [
        call('w', 'write', { file_path: 'greet.js', content: greet }),
        result('w', {
          type: 'create',
          filePath: 'greet.js',
          content: greet,
          structuredPatch: [],
          originalFile: null,
          userModified: false,
        }),
        call('e', 'edit', {
          file_path: 'greet.js',
          old_string: 'function greet(name) {',
          new_string: 'function greet(name = "world") {',
          replace_all: false,
        }),
        result('e', {
          filePath: 'greet.js',
          oldString: 'function greet(name) {',
          newString: 'function greet(name = "world") {',
          originalFile: greet,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 4,
              newStart: 1,
              newLines: 4,
              lines: [
                '-function greet(name) {',
                '+function greet(name = "world") {',
                '   return "Hello, " + name;',
                ' }',
                ' ',
              ],
            },
          ],
          userModified: false,
          replaceAll: false,
        }),
        call('u', 'write', { file_path: '/es/workspace/notes.md', content: 'a\nb\n' }),
        result('u', {
          type: 'update',
          filePath: '/es/workspace/notes.md',
          content: 'a\nb\n',
          structuredPatch: [],
          originalFile: 'a\n',
        }),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) =>
        e.type === 'file-edit' ? [e.path, e.kind, e.added, e.removed] : [e.type, '', 0, 0],
      ),
      [
        ['greet.js', 'create', 5, 0],
        ['greet.js', 'modify', 1, 1],
        ['/es/workspace/notes.md', 'modify', 1, 0],
      ],
    )
  })

  test("its WebSearch and WebFetch calls become web events, like Cursor's", () => {
    const events = normaliseStream(
      [
        call('s', 'webSearch', { query: 'node test runner' }),
        result('s', {
          query: 'node test runner',
          results: [
            {
              tool_use_id: 'srvtoolu_1',
              content: [
                { title: 'Test runner', url: 'https://nodejs.org/api/test.html' },
                { title: 'node:test', url: 'https://example.com/node-test' },
              ],
            },
            'Two results about node:test.',
          ],
          durationSeconds: 1.2,
        }),
        call('f', 'WebFetch', { url: 'https://nodejs.org/api/test.html', prompt: 'summarise' }),
        result('f', {
          bytes: 10,
          code: 200,
          codeText: 'OK',
          result: 'x',
          durationMs: 5,
          url: 'https://nodejs.org/api/test.html',
        }),
        call('m', 'WebFetch', { url: 'https://example.com/missing', prompt: 'summarise' }),
        result('m', { code: 404, codeText: 'Not Found', url: 'https://example.com/missing' }),
        call('c', 'webSearch', { searchTerm: 'cursor search' }),
        result('c', { referenceCount: 3 }),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) =>
        e.type === 'web-search'
          ? [e.type, e.query, e.references]
          : e.type === 'web-fetch'
            ? [e.type, e.url, e.ok]
            : [e.type],
      ),
      [
        ['web-search', 'node test runner', 2],
        ['web-fetch', 'https://nodejs.org/api/test.html', true],
        ['web-fetch', 'https://example.com/missing', false],
        ['web-search', 'cursor search', 3],
      ],
    )
  })
})

describe('the Cursor harness', () => {
  test('gets MCP servers in the ACP session/new shape: env and headers as name/value pairs', () => {
    assert.deepEqual(
      acpMcpServers({
        files: {
          transport: 'stdio',
          command: 'node',
          args: ['mcp.mjs'],
          env: { ROOT: '/es', N: '1' },
        },
        docs: {
          transport: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer t' },
        },
        feed: { transport: 'sse', url: 'https://feed.example/sse', headers: {} },
      }),
      {
        files: {
          command: 'node',
          args: ['mcp.mjs'],
          env: [
            { name: 'ROOT', value: '/es' },
            { name: 'N', value: '1' },
          ],
        },
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer t' }],
        },
        feed: { type: 'sse', url: 'https://feed.example/sse', headers: [] },
      },
    )
  })

  test('with no MCP servers, the ACP shape is empty', () => {
    assert.deepEqual(acpMcpServers({}), {})
  })

  test('an MCP tool call is named mcp__<server>__<tool>, not by its per-call id', () => {
    const [event] = normaliseStream(
      [
        {
          ms: 10,
          part: {
            type: 'tool-call',
            toolCallId: 'tool_9a',
            toolName: 'acp_tool_tool_9a',
            input: { providerIdentifier: 'stamp', toolName: 'house_stamp', args: {} },
          },
        },
        { ms: 20, part: { type: 'tool-result', toolCallId: 'tool_9a', output: { success: true } } },
      ],
      0,
    )
    assert.equal(event?.type === 'tool' && event.tool, 'mcp__stamp__house_stamp')
  })
})
