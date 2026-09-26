import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import type {
  HarnessV1,
  HarnessV1NetworkSandboxSession,
  HarnessV1RequestTransformation,
  HarnessV1StreamPart,
} from '@ai-sdk/harness'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import {
  ANTIGRAVITY_HOME_SKILLS_DIR,
  ANTIGRAVITY_WORKSPACE_RULES_FILE,
  ANTIGRAVITY_WORKSPACE_SKILLS_DIR,
  antigravityEndpoints,
  toUsage as antigravityUsage,
} from '@evalsuite/harness-antigravity'
import {
  CURSOR_SDK_BUILTIN_TOOLS,
  CURSOR_SDK_HOME_SKILLS_DIR,
  CURSOR_SDK_RECOVERED_TOOLS,
  CURSOR_SDK_WORKSPACE_RULES_FILE,
  CURSOR_SDK_WORKSPACE_SKILLS_DIR,
  CursorSdkStreamTranslator,
  cursorSdkEndpoints,
  toUsage as cursorUsage,
} from '@evalsuite/harness-cursor-sdk'
import {
  GOOSE_ENDPOINTS,
  GOOSE_HOME_SKILLS_DIR,
  GOOSE_WORKSPACE_SKILLS_DIR,
} from '@evalsuite/harness-goose'
import {
  OPENCODE_ENDPOINTS,
  OPENCODE_HOME_SKILLS_DIR,
  OPENCODE_WORKSPACE_SKILLS_DIR,
} from '@evalsuite/harness-opencode'
import { applyTransformations, hostAllowed, onEndpoint } from '@evalsuite/sandbox-docker'
import { malformedCredentials, missingCredentials, resolveConfig } from '../src/config.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { defineEnvironment, layered } from '../src/environment.ts'
import { observed, tokenUsage } from '../src/harness/agent.ts'
import {
  AGENTS,
  type AgentKind,
  acpMcpServers,
  agentAuth,
  antigravityMcpServers,
  brokeringFor,
  claudeMcpServers,
  cursorMcpServers,
  gooseMcpServers,
  LAYOUTS,
  layoutOf,
} from '../src/harness/agents.ts'
import { workspaceSkillDir } from '../src/harness/index.ts'
import { normaliseStream, type StampedPart } from '../src/harness/transcript.ts'
import { antigravity, claudeCode, cursor, fakeHarness, goose, opencode } from '../src/harness.ts'
import { harnessId } from '../src/options.ts'
import { imageHarness } from '../src/sandbox/prepare.ts'
import { formatUsage } from '../src/view/model.ts'

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
      { harness: [cursor({ model: 'composer-2.5' }), claudeCode({ model: 'claude-opus-5-5' })] },
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

  test('names agent and judge keys with a line break in them, never other variables', () => {
    const config = resolveConfig(
      { harness: [cursor({ model: 'composer-2.5' })], judge: { model: 'google/gemini-3.8-flash' } },
      '/p',
    )
    const wrapped = 'AQ.abc\n   │ def'
    assert.deepEqual(
      malformedCredentials(config, {
        CURSOR_API_KEY: 'crsr_ok',
        GOOGLE_GENERATIVE_AI_API_KEY: wrapped,
        UNRELATED: wrapped,
      }),
      ['GOOGLE_GENERATIVE_AI_API_KEY (character 7)'],
    )
    assert.deepEqual(malformedCredentials(config, { CURSOR_API_KEY: ` ${'k'}` }), [
      'CURSOR_API_KEY (character 1)',
    ])
    assert.deepEqual(malformedCredentials(config, {}), [], 'unset is missingCredentials')
  })

  test('reads rules from CLAUDE.md and repo skills from .claude/skills, in its own image', () => {
    const h = claudeCode({ model: 'claude-opus-5-5' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'CLAUDE.md',
      workspaceSkillDir: '.claude/skills',
      harnessSkillDir: '.claude/skills',
    })
    assert.equal(layoutOf(cursor({ model: 'composer-2.5' })).rulesFile, 'AGENTS.md')
    assert.equal(workspaceSkillDir(cursor({ model: 'composer-2.5' })), '.cursor/skills')
    assert.equal(workspaceSkillDir(fakeHarness()), '.agents/skills')
    assert.equal(imageHarness(h), 'claude-code')
    assert.equal(imageHarness(cursor({ model: 'composer-2.5' })), 'cursor')
    assert.equal(imageHarness(fakeHarness()), 'cursor')
  })

  test("a fake agent with a layout is placed exactly like that agent, in that agent's image", () => {
    // The fixtures under test/features/harness/ run the fake agent with a layout, so this is
    // what makes them evidence for the real harnesses.
    for (const real of [
      claudeCode({ model: 'opus' }),
      cursor({ model: 'composer-2.5' }),
      antigravity({ model: 'm' }),
      opencode({ model: 'm' }),
      goose({ model: 'm' }),
    ]) {
      const fake = fakeHarness({ layout: real.kind })
      assert.deepEqual(layoutOf(fake), layoutOf(real), real.kind)
      assert.equal(imageHarness(fake), imageHarness(real), real.kind)
    }
    assert.throws(
      () => fakeHarness({ layout: 'codex' as never }),
      /fakeHarness\(\{ layout \}\) is one of 'cursor', 'claude-code', 'antigravity', 'opencode', 'goose' \(got "codex"\)/,
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

describe('the Antigravity harness', () => {
  test('its brokered requests name the served model; the others can’t say', () => {
    const served = brokeringFor(antigravity({ model: 'gemini-3.8-flash-low' }))?.servedModel
    const host = 'generativelanguage.googleapis.com'
    const path = (m: string) => `/v1beta/models/${m}:streamGenerateContent`
    assert.equal(
      served?.({ method: 'POST', host, path: path('gemini-3.8-flash') }),
      'gemini-3.8-flash',
    )
    assert.equal(served?.({ method: 'POST', host: 'example.com', path: path('x') }), undefined)
    assert.equal(served?.({ method: 'POST', host, path: '/v1beta/models' }), undefined)
    assert.equal(brokeringFor(cursor({ model: 'composer-2.5' }))?.servedModel, undefined)
    assert.equal(brokeringFor(claudeCode({ model: 'sonnet' }))?.servedModel, undefined)
  })

  test('is plain data with its own cell id, and needs a model', () => {
    const h = antigravity({ model: 'gemini-3.8-flash-medium' })
    assert.deepEqual(h, { kind: 'antigravity', model: 'gemini-3.8-flash-medium' })
    assert.equal(harnessId(h), 'antigravity:gemini-3.8-flash-medium')
    assert.equal(harnessId(antigravity({ model: 'gemini-3.8-flash-low', id: 'agy' })), 'agy')
    assert.throws(
      () => antigravity({} as never),
      /antigravity\(\) needs a model, e\.g\. antigravity\(\{ model: 'gemini-3\.8-flash-medium' \}\)/,
    )
  })

  test('is accepted by the config and needs GEMINI_API_KEY', () => {
    const config = resolveConfig({ harness: [antigravity({ model: 'm' })] }, '/p')
    assert.deepEqual(missingCredentials(config, { GOOGLE_GENERATIVE_AI_API_KEY: 'x' }), [
      'GEMINI_API_KEY',
    ])
    assert.deepEqual(missingCredentials(config, { GEMINI_API_KEY: 'x' }), [])
  })

  test('reads rules from AGENTS.md, repo skills from .agents/skills and home skills from ~/.gemini/config/skills', () => {
    const h = antigravity({ model: 'm' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'AGENTS.md',
      workspaceSkillDir: '.agents/skills',
      harnessSkillDir: '.gemini/config/skills',
    })
    assert.equal(imageHarness(h), 'antigravity')
  })

  test("gets MCP servers in the CLI's mcp_config.json shape (serverUrl, not url)", () => {
    assert.deepEqual(
      antigravityMcpServers({
        files: { transport: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: { transport: 'sse', url: 'https://docs.example/sse', headers: { A: 'b' } },
      }),
      {
        files: { command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: { serverUrl: 'https://docs.example/sse', headers: { A: 'b' } },
      },
    )
  })

  test("the catalog's endpoints and layout are the adapter's", () => {
    assert.deepEqual(AGENTS.antigravity.endpoints, antigravityEndpoints())
    assert.deepEqual(LAYOUTS.antigravity, {
      rulesFile: ANTIGRAVITY_WORKSPACE_RULES_FILE,
      workspaceSkillDir: ANTIGRAVITY_WORKSPACE_SKILLS_DIR,
      harnessSkillDir: ANTIGRAVITY_HOME_SKILLS_DIR,
    })
  })
})

describe('the OpenCode harness', () => {
  test('is plain data with its own cell id, and needs a Gemini model id', () => {
    const h = opencode({ model: 'gemini-3.8-flash' })
    assert.deepEqual(h, { kind: 'opencode', model: 'gemini-3.8-flash' })
    assert.equal(harnessId(h), 'opencode:gemini-3.8-flash')
    for (const model of [undefined, '', 'google/gemini-3.8-flash', 'anthropic/claude-sonnet-5']) {
      assert.throws(
        () => opencode({ model } as never),
        /opencode\(\) needs a Gemini model id, without a provider, since it runs on a Gemini API key, e\.g\. opencode\(\{ model: 'gemini-3\.8-flash' \}\)/,
        String(model),
      )
    }
  })

  test('is accepted by the config and needs GOOGLE_GENERATIVE_AI_API_KEY', () => {
    const config = resolveConfig({ harness: [opencode({ model: 'm' })] }, '/p')
    assert.deepEqual(missingCredentials(config, { GEMINI_API_KEY: 'x' }), [
      'GOOGLE_GENERATIVE_AI_API_KEY',
    ])
    assert.deepEqual(missingCredentials(config, { GOOGLE_GENERATIVE_AI_API_KEY: 'x' }), [])
  })

  test('OpenCode reads rules from AGENTS.md, repo skills from .opencode/skills', () => {
    const h = opencode({ model: 'm' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'AGENTS.md',
      workspaceSkillDir: OPENCODE_WORKSPACE_SKILLS_DIR,
      harnessSkillDir: OPENCODE_HOME_SKILLS_DIR,
    })
    assert.equal(imageHarness(h), 'opencode')
    assert.deepEqual(AGENTS.opencode.endpoints, OPENCODE_ENDPOINTS)
  })

  test('gets MCP servers in the ACP session/new shape, variables and headers as pairs', () => {
    assert.deepEqual(
      acpMcpServers({
        files: { transport: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: { command: 'npx', args: ['mcp-files'], env: [{ name: 'ROOT', value: '/es' }] },
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: [{ name: 'A', value: 'b' }],
        },
      },
    )
  })

  test('its brokered requests name the served model, as Antigravity’s do', () => {
    const served = brokeringFor(opencode({ model: 'gemini-3.8-flash' }))?.servedModel
    assert.equal(
      served?.({
        method: 'POST',
        host: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
      }),
      'gemini-3.8-flash',
    )
  })
})

describe('the Goose harness', () => {
  test('is plain data with its own cell id, and needs a Gemini model id', () => {
    const h = goose({ model: 'gemini-3.8-flash' })
    assert.deepEqual(h, { kind: 'goose', model: 'gemini-3.8-flash' })
    assert.equal(harnessId(h), 'goose:gemini-3.8-flash')
    for (const model of [undefined, '', 'google/gemini-3.8-flash']) {
      assert.throws(
        () => goose({ model } as never),
        /goose\(\) needs a Gemini model id, without a provider, since it runs on a Gemini API key, e\.g\. goose\(\{ model: 'gemini-3\.8-flash' \}\)/,
        String(model),
      )
    }
  })

  test('is accepted by the config and needs GOOGLE_GENERATIVE_AI_API_KEY', () => {
    const config = resolveConfig({ harness: [goose({ model: 'm' })] }, '/p')
    assert.deepEqual(missingCredentials(config, { GOOGLE_API_KEY: 'x' }), [
      'GOOGLE_GENERATIVE_AI_API_KEY',
    ])
    assert.deepEqual(missingCredentials(config, { GOOGLE_GENERATIVE_AI_API_KEY: 'x' }), [])
  })

  test('Goose reads rules from AGENTS.md, repo skills from .goose/skills, home skills in its own home', () => {
    const h = goose({ model: 'm' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'AGENTS.md',
      workspaceSkillDir: GOOSE_WORKSPACE_SKILLS_DIR,
      harnessSkillDir: `.ai-sdk-harness/.harness-bootstrap/goose/implementation/home/${GOOSE_HOME_SKILLS_DIR}`,
    })
    assert.equal(imageHarness(h), 'goose')
    assert.deepEqual(AGENTS.goose.endpoints, GOOSE_ENDPOINTS)
  })

  test('gets MCP servers as Goose extensions (stdio and streamable_http), and refuses SSE', () => {
    assert.deepEqual(
      gooseMcpServers({
        files: { transport: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: { type: 'stdio', cmd: 'npx', args: ['mcp-files'], envs: { ROOT: '/es' } },
        docs: { type: 'streamable_http', uri: 'https://docs.example/mcp', headers: { A: 'b' } },
      },
    )
    assert.throws(
      () =>
        gooseMcpServers({ old: { transport: 'sse', url: 'https://x.example/sse', headers: {} } }),
      /Goose has no SSE MCP transport, so it can't use the old server \(mcp\.sse\): use mcp\.http or mcp\.stdio/,
    )
  })
})

describe('the Cursor harness', () => {
  test('is plain data with its own cell id, and needs a model', () => {
    const h = cursor({ model: 'composer-2.5', params: { fast: 'false' } })
    assert.deepEqual(h, { kind: 'cursor', model: 'composer-2.5', params: { fast: 'false' } })
    assert.deepEqual(JSON.parse(JSON.stringify(h)), h)
    assert.equal(harnessId(h), 'cursor:composer-2.5')
    assert.throws(
      () => cursor({} as never),
      /cursor\(\) needs a model, e\.g\. cursor\(\{ model: 'composer-2\.5' \}\)/,
    )
    assert.throws(
      () => cursor({ model: 'm', params: { fast: false } as never }),
      /cursor\(\{ params \}\) maps parameter ids to string values/,
    )
  })

  test('is accepted by the config and needs CURSOR_API_KEY', () => {
    const config = resolveConfig({ harness: [cursor({ model: 'm' })] }, '/p')
    assert.deepEqual(missingCredentials(config, {}), ['CURSOR_API_KEY'])
    assert.deepEqual(missingCredentials(config, { CURSOR_API_KEY: 'x' }), [])
  })

  test("is the default harness, on Cursor's own model", () => {
    assert.deepEqual(resolveConfig({}, '/p').harness, [cursor({ model: 'composer-2.5' })])
  })

  test("reads AGENTS.md, .cursor/skills and ~/.agents/skills; the catalog matches the adapter's", () => {
    const h = cursor({ model: 'm' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: CURSOR_SDK_WORKSPACE_RULES_FILE,
      workspaceSkillDir: CURSOR_SDK_WORKSPACE_SKILLS_DIR,
      harnessSkillDir: CURSOR_SDK_HOME_SKILLS_DIR,
    })
    assert.equal(imageHarness(h), 'cursor')
    assert.deepEqual(AGENTS.cursor.endpoints, cursorSdkEndpoints())
  })

  test("gets MCP servers in the SDK's McpServerConfig shape", () => {
    assert.deepEqual(
      cursorMcpServers({
        files: { transport: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: { type: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: { type: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      },
    )
  })

  test('a real turn normalises: relative edits, mcp__ names, timed tools', () => {
    const t = new CursorSdkStreamTranslator({ workDir: '/es/workspace' })
    const ndjson = readFileSync(
      new URL('../../harness-cursor-sdk/test/fixtures/tools-mcp-skills.ndjson', import.meta.url),
      'utf8',
    )
    // As HarnessAgent hands them on: tool inputs parsed, tool results as `output`.
    const parts = ndjson.split('\n').flatMap((line, i) =>
      t.push(line).map((part) => ({
        ms: i * 10,
        part:
          part.type === 'tool-call'
            ? { ...part, input: JSON.parse(part.input) }
            : part.type === 'tool-result'
              ? { ...part, output: part.result }
              : part,
      })),
    )
    const events = normaliseStream(parts as never, Date.parse('2026-09-26T12:00:00.000Z'))
    const shape = events
      .filter((e) => e.type !== 'reasoning' && e.type !== 'text')
      .map((e) =>
        e.type === 'file-edit'
          ? `edit:${e.kind}:${e.path}:+${e.added}-${e.removed}`
          : e.type === 'tool'
            ? `tool:${e.tool}`
            : e.type,
      )
    assert.deepEqual(shape, [
      'tool:bash',
      'tool:grep',
      'tool:read',
      'tool:read',
      'tool:glob',
      'edit:create:notes.txt:+1-0',
      'tool:mcp__codes__get_code',
      'edit:modify:notes.txt:+1-1',
      'edit:delete:old.txt:+0-null',
    ])
    const bash = events.find((e) => e.type === 'tool' && e.tool === 'bash')
    assert.equal(bash?.type === 'tool' && bash.output, 'hi-from-shell\n')
    assert.ok(
      events.every((e) => !('durationMs' in e) || e.durationMs === null || e.durationMs >= 0),
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
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
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
    const adapter = await agent.adapter({
      auth: agentAuth(agent),
      descriptor: { kind, model: 'm' } as never,
    })
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
    const { endpoints } = brokeringFor(cursor({ model: 'composer-2.5' })) ?? { endpoints: [] }
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
    const tokens = brokeringFor(cursor({ model: 'composer-2.5' }))?.tokens
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

  test("Antigravity's adapter brokers only GEMINI_API_KEY to the Gemini API, whatever else the host has", async () => {
    const rules = await adapterRules('antigravity', {
      ...everything,
      GEMINI_API_KEY: 'AIza-real',
      GOOGLE_API_KEY: 'host-google',
      GOOGLE_GENERATIVE_AI_API_KEY: 'host-judge',
      GOOGLE_GEMINI_BASE_URL: 'https://proxy.example',
    })
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.match.host, 'generativelanguage.googleapis.com', 'never the host proxy')
    assert.deepEqual(rules[0]?.transform.headers, { 'x-goog-api-key': 'AIza-real' })
  })

  test("the key is swapped in on Antigravity's model endpoint only; anything else is refused", async () => {
    const brokering = brokeringFor(antigravity({ model: 'm' }))
    assert.equal(brokering?.credential, 'GEMINI_API_KEY')
    const rules = await adapterRules('antigravity', { GEMINI_API_KEY: 'AIza-real' })
    const placeholder = String(rules[0]?.match.headers?.[0]?.value?.exact ?? 'missing')
    assert.match(placeholder, /^aisdkhc_/)
    const send = (method: string, path: string) =>
      applyTransformations(
        rules,
        {
          host: 'generativelanguage.googleapis.com',
          method,
          path,
          headers: { 'x-goog-api-key': placeholder },
        },
        brokering?.endpoints,
      )
    for (const path of [
      '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
      '/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent?alt=sse',
    ]) {
      assert.equal(send('POST', path).headers['x-goog-api-key'], 'AIza-real', path)
    }
    for (const [method, path] of [
      ['GET', '/v1beta/models'],
      ['GET', '/v1beta/models/gemini-3.8-flash:streamGenerateContent'],
      ['POST', '/v1beta/models/gemini-3.8-flash:generateContent'],
      ['POST', '/v1beta/files'],
      ['POST', '/upload/v1beta/files'],
      ['POST', '/v1beta/cachedContents'],
    ] as const) {
      const r = send(method, path)
      assert.equal(r.refused, true, `${method} ${path}`)
      assert.equal(r.headers['x-goog-api-key'], placeholder, `${method} ${path}`)
    }
  })

  test("Antigravity fails closed on a sandbox that can't broker: the key never goes in", async () => {
    process.env.GEMINI_API_KEY = 'AIza-real'
    try {
      const agent = AGENTS.antigravity
      const adapter = await agent.adapter({ auth: agentAuth(agent) })
      const { session } = recordingSession()
      const { addRequestTransformations: _, ...plain } = session
      let spawned = false
      await assert.rejects(
        adapter.doStart({
          sessionId: 's',
          sandboxSession: {
            ...plain,
            spawn: async () => {
              spawned = true
              throw new Error('spawned')
            },
          },
        }),
        /can't broker GEMINI_API_KEY/,
      )
      assert.equal(spawned, false)
    } finally {
      delete process.env.GEMINI_API_KEY
    }
  })

  test("OpenCode's adapter brokers only GOOGLE_GENERATIVE_AI_API_KEY to the Gemini API, whatever else the host has", async () => {
    const rules = await adapterRules('opencode', {
      ...everything,
      GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real',
      GEMINI_API_KEY: 'host-gemini',
      GOOGLE_API_KEY: 'host-google',
    })
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.match.host, 'generativelanguage.googleapis.com')
    assert.deepEqual(rules[0]?.transform.headers, { 'x-goog-api-key': 'AIza-real' })
  })

  test("the key is swapped in on OpenCode's model endpoint only; anything else is refused", async () => {
    const brokering = brokeringFor(opencode({ model: 'm' }))
    assert.equal(brokering?.credential, 'GOOGLE_GENERATIVE_AI_API_KEY')
    const rules = await adapterRules('opencode', { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' })
    const placeholder = String(rules[0]?.match.headers?.[0]?.value?.exact ?? 'missing')
    assert.match(placeholder, /^aisdkhc_/)
    const send = (method: string, path: string) =>
      applyTransformations(
        rules,
        {
          host: 'generativelanguage.googleapis.com',
          method,
          path,
          headers: { 'x-goog-api-key': placeholder },
        },
        brokering?.endpoints,
      )
    assert.equal(
      send('POST', '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse').headers[
        'x-goog-api-key'
      ],
      'AIza-real',
    )
    for (const [method, path] of [
      ['GET', '/v1beta/models'],
      ['POST', '/v1beta/models/gemini-3.8-flash:generateContent'],
      ['POST', '/v1beta/files'],
    ] as const) {
      const r = send(method, path)
      assert.equal(r.refused, true, `${method} ${path}`)
      assert.equal(r.headers['x-goog-api-key'], placeholder, `${method} ${path}`)
    }
  })

  test("OpenCode fails closed on a sandbox that can't broker: the key never goes in", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIza-real'
    try {
      const agent = AGENTS.opencode
      const adapter = await agent.adapter({
        auth: agentAuth(agent),
        descriptor: opencode({ model: 'm' }),
      })
      const { session } = recordingSession()
      const { addRequestTransformations: _, ...plain } = session
      let ran = false
      await assert.rejects(
        adapter.doStart({
          sessionId: 's',
          sandboxSession: {
            ...plain,
            run: async () => {
              ran = true
              throw new Error('ran')
            },
          },
        }),
        /can't broker GOOGLE_GENERATIVE_AI_API_KEY/,
      )
      assert.equal(ran, false)
    } finally {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    }
  })

  test("Goose's adapter brokers only the Gemini key, as GOOGLE_API_KEY, to the Gemini API", async () => {
    const rules = await adapterRules('goose', {
      ...everything,
      GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real',
      GOOGLE_API_KEY: 'host-google',
      GEMINI_API_KEY: 'host-gemini',
    })
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.match.host, 'generativelanguage.googleapis.com')
    assert.deepEqual(rules[0]?.transform.headers, { 'x-goog-api-key': 'AIza-real' })
    assert.equal(brokeringFor(goose({ model: 'm' }))?.credential, 'GOOGLE_GENERATIVE_AI_API_KEY')
  })

  test("Goose fails closed on a sandbox that can't broker: the key never goes in", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIza-real'
    try {
      const agent = AGENTS.goose
      const adapter = await agent.adapter({
        auth: agentAuth(agent),
        descriptor: goose({ model: 'm' }),
      })
      const { session } = recordingSession()
      const { addRequestTransformations: _, ...plain } = session
      let ran = false
      await assert.rejects(
        adapter.doStart({
          sessionId: 's',
          sandboxSession: {
            ...plain,
            run: async () => {
              ran = true
              throw new Error('ran')
            },
          },
        }),
        /can't broker GOOGLE_API_KEY/,
      )
      assert.equal(ran, false)
    } finally {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    }
  })

  test('with no credential set, the harness fails closed before the adapter starts', async () => {
    await assert.rejects(
      adapterRules('claude-code', { AI_GATEWAY_API_KEY: 'host-gateway' }),
      /ANTHROPIC_API_KEY isn't set, so the Claude Code harness can't authenticate/,
    )
    await assert.rejects(
      adapterRules('antigravity', { GOOGLE_GENERATIVE_AI_API_KEY: 'host-judge' }),
      /GEMINI_API_KEY isn't set, so the Antigravity harness can't authenticate/,
    )
  })
})

describe('OpenCode transcripts', () => {
  test("OpenCode's edits and writes are file edits, relative to the workspace", () => {
    const call = (id: string, toolName: string, input: unknown) => ({
      ms: 10,
      part: { type: 'tool-call', toolCallId: id, toolName, input },
    })
    const result = (id: string, output: unknown) => ({
      ms: 20,
      part: { type: 'tool-result', toolCallId: id, output },
    })
    // OpenCode 1.18.32's own outputs (ACP rawOutput).
    const events = normaliseStream(
      [
        call('w', 'write', { filePath: '/es/workspace/b.txt', content: 'bee\nsting\n' }),
        result('w', { output: 'Wrote file successfully.', metadata: { exists: false } }),
        call('o', 'write', { filePath: 'b.txt', content: 'bee\n' }),
        result('o', { output: 'Wrote file successfully.', metadata: { exists: true } }),
        call('e', 'edit', { filePath: '/es/workspace/src/a.ts', oldString: 'a', newString: 'b' }),
        result('e', {
          output: 'Edit applied successfully.',
          metadata: { filediff: { file: '/es/workspace/src/a.ts', additions: 2, deletions: 1 } },
        }),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) => (e.type === 'file-edit' ? [e.path, e.kind, e.added, e.removed] : e.type)),
      [
        ['b.txt', 'create', 2, 0],
        ['b.txt', 'modify', null, null],
        ['src/a.ts', 'modify', 2, 1],
      ],
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

describe('Antigravity transcripts', () => {
  const call = (id: string, toolName: string, input: unknown) => ({
    ms: 10,
    part: { type: 'tool-call', toolCallId: id, toolName, input },
  })
  const result = (id: string, output: unknown) => ({
    ms: 20,
    part: { type: 'tool-result', toolCallId: id, output },
  })

  test("its native tool shapes normalise like the other agents' (CLI 1.2.11)", () => {
    const events = normaliseStream(
      [
        call('w', 'write', { TargetFile: '/es/workspace/a.txt', file_path: '/es/workspace/a.txt' }),
        result('w', null),
        call('e', 'edit', { TargetFile: '/es/workspace/a.txt', file_path: '/es/workspace/a.txt' }),
        result('e', null),
        call('b', 'bash', { CommandLine: 'cat a.txt', command: 'cat a.txt' }),
        result('b', 'hi\r\nthere\r\n'),
        call('s', 'webSearch', { query: 'antigravity cli' }),
        result('s', 'Search results'),
        call('f', 'webFetch', { Url: 'https://example.com', url: 'https://example.com' }),
        result('f', 'Example Domain'),
        call('r', 'read', { AbsolutePath: '/nope.txt', file_path: '/nope.txt' }),
        {
          ms: 25,
          part: { type: 'tool-error', toolCallId: 'r', error: 'stat /nope.txt: no such file' },
        },
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) =>
        e.type === 'file-edit'
          ? [e.type, e.path, e.kind]
          : e.type === 'web-search'
            ? [e.type, e.query]
            : e.type === 'web-fetch'
              ? [e.type, e.url, e.ok]
              : e.type === 'tool'
                ? [e.type, e.tool, e.output, e.ok]
                : [e.type],
      ),
      [
        ['file-edit', '/es/workspace/a.txt', 'modify'],
        ['file-edit', '/es/workspace/a.txt', 'modify'],
        ['tool', 'bash', 'hi\nthere\n', true],
        ['web-search', 'antigravity cli'],
        ['web-fetch', 'https://example.com', true],
        ['tool', 'read', 'stat /nope.txt: no such file', false],
      ],
    )
  })
})

/**
 * A harness that emits `parts` for every turn, through a real HarnessAgent, as ES drives it.
 * `stream` is the agent's `fullStream`, stamped as ES stamps it for `normaliseStream`.
 */
async function turnThrough(
  parts: HarnessV1StreamPart[],
  builtinTools: HarnessV1['builtinTools'] = {},
) {
  let served: string | undefined
  const adapter: HarnessV1 = {
    specificationVersion: 'harness-v1',
    harnessId: 'scripted',
    builtinTools,
    doStart: async ({ sessionId }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async (turn) => {
        for (const part of parts) turn.emit(part)
        return { submitToolResult: async () => {}, done: Promise.resolve() }
      },
      doCompact: async () => {},
      doContinueTurn: async () => ({ submitToolResult: async () => {}, done: Promise.resolve() }),
      doSuspendTurn: async () => ({}) as never,
      doDetach: async () => ({}) as never,
      doStop: async () => ({}) as never,
      doDestroy: async () => {},
    }),
  } as HarnessV1
  const agent = new HarnessAgent({
    harness: observed(adapter, (part) => {
      if (part.type === 'stream-start' && part.modelId) served = part.modelId
    }),
    model: 'requested-model',
    permissionMode: 'allow-all',
  })
  const sandboxSession = {
    description: 'none',
    defaultWorkingDirectory: '/es',
    run: async () => ({ exitCode: 0, stdout: '/root', stderr: '' }),
    restricted: () => sandboxSession,
  }
  const session = await agent.createSession({ sandboxSession: sandboxSession as never })
  const result = await agent.stream({ session, prompt: 'go' })
  const stream: StampedPart[] = []
  for await (const part of result.fullStream) {
    stream.push({ ms: stream.length, part: part as StampedPart['part'] })
  }
  return { usage: tokenUsage(await result.totalUsage), served, stream }
}

describe('Cursor web tools at every layer: SDK, adapter, HarnessAgent, normaliser', () => {
  const WEB = new Set(['webSearch', 'webFetch'])
  const fixture = (name: string) =>
    readFileSync(new URL(`../../harness-cursor-sdk/test/fixtures/${name}`, import.meta.url), 'utf8')

  /** The web calls each layer hands the next, from the first turn of a captured runner session. */
  async function layers(name: string, startedAt: number) {
    const [turn = ''] = fixture(name)
      .trim()
      .split(/\n(?=\{"type":"init")/)
    const lines = turn.split('\n')
    const sdk = lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.type === 'event' && l.event.type === 'tool_call' && WEB.has(l.event.name))
      .filter((l) => l.event.status === 'running')
      .map((l) => l.event.name as string)
    const t = new CursorSdkStreamTranslator({ workDir: '/es/workspace' })
    const parts = lines.flatMap((l) => t.push(l))
    const webCalls = (ps: Array<{ type: string; toolName?: string }>) =>
      ps.flatMap((p) => (p.type === 'tool-call' && WEB.has(p.toolName ?? '') ? [p.toolName] : []))
    const adapter = webCalls(parts)
    const { stream } = await turnThrough(parts, CURSOR_SDK_BUILTIN_TOOLS)
    const agent = webCalls(stream.map((s) => s.part as { type: string; toolName?: string }))
    const events = normaliseStream(stream, startedAt).filter(
      (e) => e.type === 'web-search' || e.type === 'web-fetch',
    )
    return { sdk, adapter, agent, events }
  }

  test('web calls the runner recovers survive the adapter, HarnessAgent and the normaliser', async () => {
    const startedAt = 1790444242000
    const { sdk, adapter, agent, events } = await layers('web-recovered.ndjson', startedAt)
    assert.deepEqual(sdk, ['webFetch', 'webSearch'])
    assert.deepEqual(adapter, sdk, 'the adapter maps both to provider-executed builtins')
    assert.deepEqual(agent, sdk, 'HarnessAgent passes provider-executed builtins on')
    // Placed and timed by the backend's own clock, though reported after the turn.
    assert.deepEqual(
      events.map((e) =>
        e.type === 'web-search'
          ? [e.type, e.query, e.references, e.atMs, e.durationMs]
          : [e.type, e.url, e.ok, e.atMs, e.durationMs],
      ),
      [
        ['web-search', 'IANA example domain RFC 2606', 2, 461, 4042],
        ['web-fetch', 'https://httpbin.org/ip', true, 467, 1242],
      ],
    )
  })

  test('SDK 1.0.32 loses them before our first layer: its stream alone has none anywhere', async () => {
    const { sdk, adapter, agent, events } = await layers('web-1.0.32.ndjson', 0)
    assert.deepEqual([sdk, adapter, agent, events], [[], [], [], []])
  })

  test("a Cursor turn is unreported for the web tools the runner couldn't recover", () => {
    const unreported = AGENTS.cursor.unreported
    assert.ok(unreported)
    assert.deepEqual(
      unreported({ cursorSdk: { unreportedTools: Object.values(CURSOR_SDK_RECOVERED_TOOLS) } }),
      ['web-search', 'web-fetch'],
    )
    assert.deepEqual(unreported({ cursorSdk: { runId: 'run-1' } }), [])
    assert.deepEqual(unreported(undefined), [])
    for (const kind of ['claude-code', 'antigravity'] as const) {
      assert.equal(AGENTS[kind].unreported, undefined)
    }
  })
})

const finishWith = (usage: unknown, modelId?: string): HarnessV1StreamPart[] => [
  { type: 'stream-start', ...(modelId ? { modelId } : {}) },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'ok' },
  { type: 'text-end', id: 't' },
  { type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage as never },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, totalUsage: usage as never },
]

describe('token usage and the served model, from any harness', () => {
  test('Antigravity: cache reads larger than input stay positive, and the model is kept', async () => {
    // A real gemini-3.8-flash turn's counts.
    const agy = antigravityUsage({
      input_tokens: 70161,
      output_tokens: 412,
      thinking_tokens: 30,
      cache_read_tokens: 143477,
    })
    const { usage, served } = await turnThrough(finishWith(agy, 'gemini-3.8-flash-low'))
    assert.deepEqual(usage, {
      input: 70161,
      output: 412,
      cacheRead: 143477,
      cacheWrite: 0,
      reasoning: 30,
    })
    assert.equal(served, 'gemini-3.8-flash-low')
  })

  test('Cursor: uncached input, cache reads and writes as the SDK splits them', async () => {
    const sdk = cursorUsage({
      inputTokens: 15564,
      outputTokens: 117,
      cacheReadTokens: 10464,
      cacheWriteTokens: 12,
      totalTokens: 26157,
    })
    const { usage, served } = await turnThrough(finishWith(sdk, 'composer-2.5[fast=false]'))
    assert.deepEqual(usage, {
      input: 15564,
      output: 117,
      cacheRead: 10464,
      cacheWrite: 12,
      reasoning: null,
    })
    assert.equal(served, 'composer-2.5[fast=false]')
  })

  test('Claude Code: the API usage its bridge maps, cache creation as cache writes', async () => {
    // harness-claude-code 1.0.128's bridge (`mapUsage`) on a real Messages API usage block:
    // input_tokens 6, cache_creation_input_tokens 4210, cache_read_input_tokens 15022, output 311.
    const claude = {
      inputTokens: { total: 19238, noCache: 6, cacheRead: 15022, cacheWrite: 4210 },
      outputTokens: { total: 311, text: 311 },
    }
    const { usage } = await turnThrough(finishWith(claude))
    assert.deepEqual(usage, {
      input: 6,
      output: 311,
      cacheRead: 15022,
      cacheWrite: 4210,
      reasoning: null,
    })
    assert.equal(formatUsage(usage), '19k in (15k cached) · 311 out')
  })

  test('a harness that reports neither records null for both', async () => {
    const none = cursorUsage(undefined)
    const { usage, served } = await turnThrough(finishWith(none))
    assert.equal(usage, null)
    assert.equal(formatUsage(usage), null)
    assert.equal(served, undefined)
  })
})
