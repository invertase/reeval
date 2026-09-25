import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, test } from 'node:test'
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness'
import {
  CLAUDE_CODE_HOSTS,
  DEFAULT_ALLOWED_HOSTS,
  harnessImageFor,
  hostAllowed,
  imageFor,
  LABEL,
  matches,
  scopeTransformations,
} from '@evalsuite/sandbox-docker'
import { missingCredentials, resolveConfig } from '../src/config.ts'
import {
  AGENTS,
  type AgentKind,
  brokeringFor,
  claudeCodeSettings,
  claudeMcpServers,
} from '../src/harness/agents.ts'
import { workspaceSkillDir } from '../src/harness/index.ts'
import { normaliseStream } from '../src/harness/transcript.ts'
import { claudeCode, cursor, fakeHarness } from '../src/harness.ts'
import { cascade, harnessId, type Level, type Resolved } from '../src/options.ts'
import { preflight } from '../src/preflight.ts'
import {
  bakedHarnessFor,
  imageBuildTargets,
  imageHint,
  prepareImage,
} from '../src/sandbox/prepare.ts'
import { docker } from '../src/sandbox.ts'
import { fakeConfig, project, runCli } from './helpers.ts'

describe('the Claude Code harness', () => {
  test('is plain data with its own cell id', () => {
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
    assert.equal(harnessId(cursor()), 'cursor')
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
    const base: Resolved = {
      harness: config.harness,
      sandbox: config.sandbox,
      environment: undefined,
      compare: undefined,
      runs: 1,
      env: {},
      judge: {},
      timeout: undefined,
      tags: [],
      pin: [],
    }
    const levels: Level[] = [{ options: { harness: claudeCode({ model: 'opus' }) }, where: 'e' }]
    const { resolved } = cascade(base, levels, 'e')
    assert.deepEqual(resolved.harness, [{ kind: 'claude-code', model: 'opus' }])
  })

  test('reads repo skills from .claude/skills and runs in its own image', () => {
    const h = claudeCode({ model: 'claude-opus-5-5' })
    assert.equal(workspaceSkillDir(h), '.claude/skills')
    assert.equal(workspaceSkillDir(cursor()), '.cursor/skills')
    assert.equal(workspaceSkillDir(fakeHarness()), '.agents/skills')
    assert.equal(bakedHarnessFor(h), 'claude-code')
    assert.equal(bakedHarnessFor(cursor()), 'cursor')
    assert.equal(bakedHarnessFor(fakeHarness()), 'cursor')
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

  test('can reach the Anthropic API under the default egress allowlist', () => {
    assert.ok(hostAllowed(CLAUDE_CODE_HOSTS, 'api.anthropic.com'))
    assert.ok(hostAllowed(DEFAULT_ALLOWED_HOSTS, 'api.anthropic.com'))
    assert.equal(hostAllowed(CLAUDE_CODE_HOSTS, 'api2.cursor.sh'), false)
  })

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

/** The rules an agent's real adapter asks the sandbox for, with `env` as the host environment. */
async function adapterRules(kind: AgentKind, env: Record<string, string>) {
  const saved = { ...process.env }
  const names = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'AI_GATEWAY_API_KEY',
    'CURSOR_API_KEY',
  ]
  for (const name of names) delete process.env[name]
  Object.assign(process.env, env)
  try {
    const adapter = await AGENTS[kind].adapter({})
    const { session, rules } = recordingSession()
    await assert.rejects(
      adapter.doStart({ sessionId: 's', sandboxSession: session }),
      /stopped by the test/,
    )
    return rules
  } finally {
    for (const name of names) delete process.env[name]
    Object.assign(process.env, saved)
  }
}

describe('credential brokering per agent', () => {
  const REAL = 'sk-ant-real-key-for-tests'

  test('Claude Code authenticates with ANTHROPIC_API_KEY alone and runs as a sandbox', () => {
    const host = {
      ANTHROPIC_API_KEY: REAL,
      ANTHROPIC_AUTH_TOKEN: 'host-token',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
      AI_GATEWAY_API_KEY: 'host-gateway',
    }
    assert.deepEqual(claudeCodeSettings({}, host), {
      auth: { ANTHROPIC_API_KEY: REAL },
      env: { IS_SANDBOX: '1' },
    })
    const mcpServers = { files: { type: 'stdio', command: 'npx' } }
    assert.deepEqual(claudeCodeSettings({ mcpServers }, {}), {
      mcpServers,
      auth: {},
      env: { IS_SANDBOX: '1' },
    })
  })

  test("Claude Code's adapter brokers only the API key, whatever else the host has", async () => {
    const rules = await adapterRules('claude-code', {
      ANTHROPIC_API_KEY: REAL,
      ANTHROPIC_AUTH_TOKEN: 'host-token',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
      AI_GATEWAY_API_KEY: 'host-gateway',
    })
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.match.host, 'api.anthropic.com')
    assert.deepEqual(rules[0]?.transform.headers, { 'x-api-key': REAL })
  })

  test("Claude Code's adapter never falls back to the host's subscription", async () => {
    assert.deepEqual(await adapterRules('claude-code', {}), [])
  })

  test("Claude Code's key only reaches the endpoints its CLI needs", async () => {
    const brokering = brokeringFor(claudeCode({ model: 'opus' }))
    assert.equal(brokering?.credential, 'ANTHROPIC_API_KEY')
    const adapterAsked = await adapterRules('claude-code', { ANTHROPIC_API_KEY: REAL })
    const rules = scopeTransformations(adapterAsked, brokering?.endpoints ?? [])
    const placeholder = String(adapterAsked[0]?.match.headers?.[0]?.value?.exact ?? 'missing')
    assert.match(placeholder, /^aisdkhc_/)
    const keyed = (method: string, path: string) =>
      rules.some((rule) =>
        matches(rule, {
          host: 'api.anthropic.com',
          method,
          path,
          headers: { 'x-api-key': placeholder },
        }),
      )
    assert.ok(keyed('POST', '/v1/messages?beta=true'))
    assert.ok(keyed('POST', '/v1/messages/count_tokens'))
    assert.ok(keyed('GET', '/api/claude_code/settings'))
    assert.ok(keyed('GET', '/api/claude_code/policy_limits'))
    assert.ok(keyed('POST', '/api/eval/sdk-zAZezfDKGoZuXXKe'))
    for (const [method, path] of [
      ['GET', '/v1/models'],
      ['POST', '/v1/files'],
      ['POST', '/v1/messages/batches'],
      ['GET', '/v1/organizations/org_1/api_keys'],
      ['GET', '/v1/messages'],
      ['POST', '/api/claude_code/settings'],
    ] as const) {
      assert.equal(keyed(method, path), false, `${method} ${path}`)
    }
  })

  test("Cursor's adapter rule passes through its endpoints unchanged", async () => {
    const adapterAsked = await adapterRules('cursor', { CURSOR_API_KEY: 'crsr_real' })
    assert.equal(adapterAsked.length, 1)
    const brokering = brokeringFor(cursor())
    assert.deepEqual(scopeTransformations(adapterAsked, brokering?.endpoints ?? []), adapterAsked)
    assert.equal(brokeringFor(fakeHarness()), undefined)
  })
})

describe('es image build', () => {
  test('builds the named harnesses once each, or else the config harnesses', () => {
    assert.deepEqual(imageBuildTargets(['claude-code', 'cursor', 'claude-code'], []), [
      'claude-code',
      'cursor',
    ])
    assert.deepEqual(imageBuildTargets(['cursor'], [claudeCode({ model: 'opus' })]), ['cursor'])
    assert.deepEqual(
      imageBuildTargets([], [fakeHarness(), cursor(), claudeCode({ model: 'opus' })]),
      ['cursor', 'claude-code'],
    )
    assert.deepEqual(imageBuildTargets([], []), [])
    assert.throws(() => imageBuildTargets(['constructor'], []), /Unknown harness "constructor"/)
  })

  test('refuses an unknown harness before building anything', async () => {
    assert.throws(
      () => imageBuildTargets(['cursor', 'codex'], []),
      /Unknown harness "codex"\. Use one of: cursor, claude-code/,
    )
    const p = await project('image-build', { 'es.config.ts': fakeConfig() })
    const r = await runCli(p.dir, ['image', 'build', 'cursor', 'codex'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /Unknown harness "codex"\. Use one of: cursor, claude-code/)
    assert.doesNotMatch(r.stdout, /Built/)
  })
})

const claudeImageReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', imageFor('claude-code')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const needsClaudeImage = {
  skip: !claudeImageReady && `needs Docker and ${imageFor('claude-code')}`,
  timeout: 60_000,
}

describe('Claude Code images', () => {
  test('a missing image names the harness to build, or says to pull a custom one', () => {
    assert.equal(
      imageHint(imageFor('claude-code')),
      'Build it once with: es image build claude-code',
    )
    assert.equal(imageHint(imageFor('cursor')), 'Build it once with: es image build cursor')
    assert.equal(imageHint('python:3.12-slim'), 'Pull or build it first')
  })

  test('each harness has its own image for docker({ from })', () => {
    const from = 'python:3.12-slim'
    assert.ok(harnessImageFor('claude-code', from).startsWith(`${imageFor('claude-code')}-`))
    assert.notEqual(harnessImageFor('claude-code', from), harnessImageFor('cursor', from))
  })

  test(
    'preflight finds the Claude Code image and names a missing one',
    needsClaudeImage,
    async () => {
      const claude = claudeCode({ model: 'opus' })
      const { images } = await preflight([{ harness: claude, sandbox: docker() }])
      assert.deepEqual(
        images.map((i) => i.ref),
        [imageFor('claude-code')],
      )
      assert.match(images[0]?.agentCli ?? '', /\d/)
      await assert.rejects(
        preflight([{ harness: claude, sandbox: docker({ image: 'evalsuite-test-missing:0' }) }]),
        /Sandbox image evalsuite-test-missing:0 not found\. Pull or build it first/,
      )
    },
  )

  test(
    'an attempt runs in the Claude Code image, or its from variant',
    needsClaudeImage,
    async () => {
      const claude = claudeCode({ model: 'opus' })
      const signal = AbortSignal.timeout(30_000)
      const plain = await prepareImage(docker(), claude, [], '/unused', signal)
      assert.equal(plain.ref, imageFor('claude-code'))
      assert.equal(
        plain.agentCli,
        execFileSync(
          'docker',
          [
            'image',
            'inspect',
            '--format',
            `{{index .Config.Labels "${LABEL.agentVersion}"}}`,
            plain.ref,
          ],
          { encoding: 'utf8' },
        ).trim(),
      )
      // A from image that is already built is used as is, so tagging one stands in for the build.
      const from = 'evalsuite-test-from:1'
      const variant = harnessImageFor('claude-code', from)
      execFileSync('docker', ['tag', imageFor('claude-code'), variant])
      try {
        const built = await prepareImage(docker({ from }), claude, [], '/unused', signal)
        assert.equal(built.ref, variant)
      } finally {
        execFileSync('docker', ['rmi', variant], { stdio: 'ignore' })
      }
    },
  )
})
