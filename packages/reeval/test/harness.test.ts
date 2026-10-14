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
  AntigravityStreamTranslator,
  antigravityEndpoints,
  toUsage as antigravityUsage,
} from '@reeval/harness-antigravity'
import {
  CODEX_ENDPOINTS,
  CODEX_HOME_SKILLS_DIR,
  CODEX_WORKSPACE_SKILLS_DIR,
} from '@reeval/harness-codex'
import {
  CURSOR_SDK_BUILTIN_TOOLS,
  CURSOR_SDK_HOME_SKILLS_DIR,
  CURSOR_SDK_RECOVERED_TOOLS,
  CURSOR_SDK_WORKSPACE_RULES_FILE,
  CURSOR_SDK_WORKSPACE_SKILLS_DIR,
  CursorSdkStreamTranslator,
  cursorSdkEndpoints,
  toUsage as cursorUsage,
} from '@reeval/harness-cursor-sdk'
import {
  GOOSE_ENDPOINTS,
  GOOSE_HOME_SKILLS_DIR,
  GOOSE_WORKSPACE_SKILLS_DIR,
} from '@reeval/harness-goose'
import {
  OPENCODE_HOME_SKILLS_DIR,
  OPENCODE_WORKSPACE_SKILLS_DIR,
  openCodeEndpoints,
} from '@reeval/harness-opencode'
import { PI_ENDPOINTS, PI_HOME_SKILLS_DIR, PI_WORKSPACE_SKILLS_DIR } from '@reeval/harness-pi'
import { applyTransformations, hostAllowed, onEndpoint } from '@reeval/sandbox-docker'
import { malformedCredentials, missingCredentials, resolveConfig } from '../src/config.ts'
import { plannedEgress } from '../src/egress.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment } from '../src/environment.ts'
import { observed, tokenUsage } from '../src/harness/agent.ts'
import {
  AGENTS,
  type AgentKind,
  agentAuth,
  agentFor,
  antigravityMcpServers,
  brokeringFor,
  claudeMcpServers,
  cursorMcpServers,
  gooseMcpServers,
  LAYOUTS,
  layoutOf,
  opencodeVars,
  type ServedModel,
} from '../src/harness/agents.ts'
import { effortFromModelLabel, harnessEffort, servedEffortOf } from '../src/harness/effort.ts'
import { workspaceSkillDir } from '../src/harness/index.ts'
import { normaliseStream, type StampedPart } from '../src/harness/transcript.ts'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fakeHarness,
  goose,
  opencode,
  pi,
} from '../src/harness.ts'
import { harnessId } from '../src/options.ts'
import { imageHarness } from '../src/sandbox/prepare.ts'
import type { AgentHarnessDescriptor, TranscriptEvent } from '../src/types.ts'
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
      missingCredentials(
        config,
        { CURSOR_API_KEY: 'x' },
        { harnesses: [claudeCode({ model: 'claude-opus-5-5' })] },
      ),
      ['ANTHROPIC_API_KEY'],
    )
    assert.deepEqual(missingCredentials(config, {}, { harnesses: [fakeHarness()] }), [])
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
      opencode({ model: 'google/m' }),
      goose({ model: 'm' }),
      pi({ model: 'm' }),
      codex({ model: 'm' }),
    ]) {
      const fake = fakeHarness({ layout: real.kind })
      assert.deepEqual(layoutOf(fake), layoutOf(real), real.kind)
      assert.equal(imageHarness(fake), imageHarness(real), real.kind)
    }
    assert.throws(
      () => fakeHarness({ layout: 'cline' as never }),
      /fakeHarness\(\{ layout \}\) is one of 'cursor', 'claude-code', 'antigravity', 'opencode', 'goose', 'pi', 'codex' \(got "cline"\)/,
    )
  })

  test('one environment has one digest, whichever file its rules go to', async () => {
    const house = defineEnvironment('house', {
      rules: 'Always write tests.',
      files: { 'notes.txt': 'hi' },
    })
    const forFile = (file: string) => resolveEnvironment(applied(house), {}, '/p', 'e', file)
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
    const changed = await resolveEnvironment(applied(edited), {}, '/p', 'e', 'CLAUDE.md')
    assert.notEqual(changed.record.digest, claude.record.digest, 'the rules are in the digest')
  })

  test('rules win over a file at the same path', async () => {
    const env = defineEnvironment('both', {
      files: { 'CLAUDE.md': 'from files' },
      rules: 'from rules',
    })
    const r = await resolveEnvironment(applied(env), {}, '/p', 'e', 'CLAUDE.md')
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
  test('is plain data with its own cell id, and needs a model on a provider it can broker', () => {
    const h = opencode({ model: 'google/gemini-3.8-flash' })
    assert.deepEqual(h, { kind: 'opencode', model: 'google/gemini-3.8-flash' })
    assert.equal(harnessId(h), 'opencode:gemini-3.8-flash')
    assert.equal(
      harnessId(opencode({ model: 'openrouter/anthropic/claude-haiku-4.5' })),
      'opencode:claude-haiku-4.5',
    )
    for (const model of [undefined, '']) {
      assert.throws(
        () => opencode({ model } as never),
        /opencode\(\): needs a model, <provider>\/<model>, e\.g\. opencode\(\{ model: 'google\/gemini-3\.8-flash' \}\)/,
        String(model),
      )
    }
    assert.throws(
      () => opencode({ model: 'gemini-3.8-flash' }),
      /^UsageError: opencode\(\): an OpenCode model id names its provider, <provider>\/<model>/,
    )
    assert.throws(
      () => opencode({ model: 'google-vertex/gemini-3.8-flash' }),
      /^UsageError: opencode\(\): reeval can't run OpenCode on Vertex \(google-vertex\): it takes a service account/,
    )
    assert.throws(() => opencode({ model: 'nope/m' }), /OpenCode has no provider "nope"/)
  })

  test("the config refuses a hand-made descriptor on a provider it can't broker", () => {
    assert.throws(
      () =>
        resolveConfig({ harness: [{ kind: 'opencode', model: 'google-vertex/x' }] } as never, '/p'),
      /^UsageError: opencode\(\) in reeval\.config\.ts: reeval can't run OpenCode on Vertex/,
    )
  })

  test("needs only the model's provider's key", () => {
    const config = resolveConfig(
      {
        harness: [
          opencode({ model: 'google/m' }),
          opencode({ model: 'anthropic/claude-haiku-4-5' }),
          opencode({ model: 'openrouter/openai/gpt-5.4', id: 'or' }),
        ],
      },
      '/p',
    )
    assert.deepEqual(missingCredentials(config, { GEMINI_API_KEY: 'x' }), [
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
    ])
    assert.deepEqual(
      missingCredentials(
        config,
        { GOOGLE_GENERATIVE_AI_API_KEY: 'x' },
        {
          harnesses: [opencode({ model: 'google/m' })],
        },
      ),
      [],
    )
    assert.deepEqual(
      malformedCredentials(config, { ANTHROPIC_API_KEY: 'a b', OPENAI_API_KEY: 'c d' }),
      ['ANTHROPIC_API_KEY (character 2)'],
    )
  })

  test("on Bedrock, it needs AWS_BEARER_TOKEN_BEDROCK, and AWS_REGION's hosts are its egress hosts", () => {
    const bedrock = opencode({ model: 'amazon-bedrock/global.anthropic.claude-haiku-4-5' })
    const config = resolveConfig({ harness: [bedrock] }, '/p')
    assert.deepEqual(missingCredentials(config, { AWS_ACCESS_KEY_ID: 'x' }), [
      'AWS_BEARER_TOKEN_BEDROCK',
    ])
    assert.deepEqual(missingCredentials(config, { AWS_BEARER_TOKEN_BEDROCK: 'x' }), [])
    const saved = process.env.AWS_REGION
    try {
      delete process.env.AWS_REGION
      const hosts = () => plannedEgress({ own: 'deny-all' }, bedrock, {}, []).auto
      assert.deepEqual(hosts(), [
        'bedrock-mantle.us-east-1.api.aws',
        'bedrock-runtime.us-east-1.amazonaws.com',
        'mcp.exa.ai',
      ])
      process.env.AWS_REGION = 'ap-southeast-2'
      assert.deepEqual(hosts(), [
        'bedrock-mantle.ap-southeast-2.api.aws',
        'bedrock-runtime.ap-southeast-2.amazonaws.com',
        'mcp.exa.ai',
      ])
      assert.deepEqual(opencodeVars(bedrock.model), { AWS_REGION: 'ap-southeast-2' })
      assert.equal(
        brokeringFor(bedrock)?.servedModel?.({
          method: 'POST',
          host: 'bedrock-runtime.ap-southeast-2.amazonaws.com',
          path: '/model/global.anthropic.claude-haiku-4-5/converse-stream',
        }),
        'global.anthropic.claude-haiku-4-5',
      )
      process.env.AWS_REGION = 'evil.example.com'
      assert.throws(
        () => opencode({ model: bedrock.model }),
        /^UsageError: opencode\(\): AWS_REGION is "evil\.example\.com"/,
      )
      assert.throws(
        () => brokeringFor(bedrock),
        /^InfraError: opencode\(\): AWS_REGION is "evil\.example\.com"/,
      )
    } finally {
      if (saved === undefined) delete process.env.AWS_REGION
      else process.env.AWS_REGION = saved
    }
  })

  test("each provider's hosts are its automatic egress hosts, with Exa's for web search", () => {
    const hosts = (model: string) =>
      plannedEgress({ own: 'deny-all' }, opencode({ model }), {}, []).auto
    assert.deepEqual(hosts('google/m'), ['generativelanguage.googleapis.com', 'mcp.exa.ai'])
    assert.deepEqual(hosts('anthropic/claude-haiku-4-5'), ['api.anthropic.com', 'mcp.exa.ai'])
    assert.deepEqual(hosts('openai/gpt-5.4-mini'), ['api.openai.com', 'mcp.exa.ai'])
    assert.deepEqual(hosts('openrouter/x/y'), ['openrouter.ai', 'mcp.exa.ai'])
  })

  test('OpenCode reads rules from AGENTS.md, repo skills from .opencode/skills', () => {
    const h = opencode({ model: 'google/m' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'AGENTS.md',
      workspaceSkillDir: OPENCODE_WORKSPACE_SKILLS_DIR,
      harnessSkillDir: OPENCODE_HOME_SKILLS_DIR,
    })
    assert.equal(imageHarness(h), 'opencode')
    assert.deepEqual(brokeringFor(h)?.endpoints, openCodeEndpoints('google/m'))
  })

  test("gets MCP servers in its config's shape, and refuses SSE", () => {
    assert.deepEqual(
      AGENTS.opencode.mcpServers({
        files: { transport: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/es' } },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: { type: 'local', command: ['npx', 'mcp-files'], environment: { ROOT: '/es' } },
        docs: {
          type: 'remote',
          url: 'https://docs.example/mcp',
          headers: { A: 'b' },
          oauth: false,
        },
      },
    )
    assert.throws(
      () =>
        AGENTS.opencode.mcpServers({
          old: { transport: 'sse', url: 'https://x.example/sse', headers: {} },
        }),
      /^InfraError: OpenCode has no SSE MCP transport, so it can't use the old server \(mcp\.sse\)/,
    )
  })

  test('its brokered requests name the served model, as Antigravity’s do', () => {
    const served = brokeringFor(opencode({ model: 'google/gemini-3.8-flash' }))?.servedModel
    assert.equal(
      served?.({
        method: 'POST',
        host: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
      }),
      'gemini-3.8-flash',
    )
  })

  test("elsewhere the gateway reads the served model from each model call's response", () => {
    const anthropic = brokeringFor(opencode({ model: 'anthropic/claude-haiku-4-5' }))
    assert.equal(anthropic?.credential, 'ANTHROPIC_API_KEY')
    assert.deepEqual(anthropic?.modelResponses, anthropic?.endpoints)
    assert.equal(
      anthropic?.servedModel?.({
        method: 'POST',
        host: 'api.anthropic.com',
        path: '/v1/messages',
        responseModel: 'claude-haiku-4-5-20251001',
      }),
      'claude-haiku-4-5-20251001',
    )
    const openai = brokeringFor(opencode({ model: 'openai/gpt-5.4-mini' }))
    assert.equal(
      openai?.servedModel?.({
        method: 'POST',
        host: 'api.openai.com',
        path: '/v1/responses',
        responseModel: 'gpt-5.4-mini-2026-03-17',
        responseEffort: 'none',
      }),
      'gpt-5.4-mini-2026-03-17[effort=none]',
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

describe('mcp.sse', () => {
  test('resolves to an SSE server and reaches every harness in its SSE shape, or is refused by name', async () => {
    const env = defineEnvironment('events', ({ mcp }) => ({
      mcp: { events: mcp.sse('http://events.example/sse', { headers: { A: 'b' } }) },
    }))
    const { mcp } = await resolveEnvironment(applied(env), {}, '/p', 'e', 'AGENTS.md')
    assert.deepEqual(mcp, {
      events: { transport: 'sse', url: 'http://events.example/sse', headers: { A: 'b' } },
    })
    const expected: Record<AgentKind, unknown> = {
      cursor: { events: { type: 'sse', url: 'http://events.example/sse', headers: { A: 'b' } } },
      'claude-code': {
        events: { type: 'sse', url: 'http://events.example/sse', headers: { A: 'b' } },
      },
      antigravity: { events: { serverUrl: 'http://events.example/sse', headers: { A: 'b' } } },
      opencode:
        /^InfraError: OpenCode has no SSE MCP transport, so it can't use the events server \(mcp\.sse\)/,
      goose:
        /^InfraError: Goose has no SSE MCP transport, so it can't use the events server \(mcp\.sse\)/,
      pi: /^InfraError: pi has no SSE MCP transport, so it can't use the events server \(mcp\.sse\)/,
      codex:
        /^InfraError: Codex has no SSE MCP transport, so it can't use the events server \(mcp\.sse\)/,
    }
    for (const [kind, shape] of Object.entries(expected) as [AgentKind, unknown][]) {
      const toHarness = () => AGENTS[kind].mcpServers(mcp as never)
      if (shape instanceof RegExp) assert.throws(toHarness, shape, kind)
      else assert.deepEqual(toHarness(), shape, kind)
    }
    assert.deepEqual(Object.keys(expected).sort(), Object.keys(AGENTS).sort(), 'every harness')
  })
})

describe('the pi harness', () => {
  test('is plain data with its own cell id, and needs a Gemini model id', () => {
    const h = pi({ model: 'gemini-3.8-flash' })
    assert.deepEqual(h, { kind: 'pi', model: 'gemini-3.8-flash' })
    assert.equal(harnessId(h), 'pi:gemini-3.8-flash')
    assert.throws(
      () => pi({ model: 'google/gemini-3.8-flash' }),
      /pi\(\) needs a Gemini model id, without a provider, since it runs on a Gemini API key, e\.g\. pi\(\{ model: 'gemini-3\.8-flash' \}\)/,
    )
  })

  test('pi reads rules from AGENTS.md, repo skills from .pi/skills and home skills from ~/.pi/agent/skills', () => {
    const h = pi({ model: 'm' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'AGENTS.md',
      workspaceSkillDir: PI_WORKSPACE_SKILLS_DIR,
      harnessSkillDir: PI_HOME_SKILLS_DIR,
    })
    assert.equal(imageHarness(h), 'pi')
    assert.deepEqual(AGENTS.pi.endpoints, PI_ENDPOINTS)
    const config = resolveConfig({ harness: [h] }, '/p')
    assert.deepEqual(missingCredentials(config, { GEMINI_API_KEY: 'x' }), [
      'GOOGLE_GENERATIVE_AI_API_KEY',
    ])
  })

  test("MCP servers go in pi's mcp.json shape; it has no SSE transport and refuses odd names", () => {
    assert.deepEqual(
      AGENTS.pi.mcpServers({
        stamp: { transport: 'stdio', command: 'node', args: ['s.mjs'], env: { A: '$b' } },
        'web_2-x': { transport: 'http', url: 'https://x.test/mcp', headers: { H: '!v' } },
      }),
      {
        stamp: { command: 'node', args: ['s.mjs'], env: { A: '$b' } },
        'web_2-x': { url: 'https://x.test/mcp', headers: { H: '!v' } },
      },
    )
    assert.throws(
      () => AGENTS.pi.mcpServers({ s: { transport: 'sse', url: 'https://x.test', headers: {} } }),
      /^InfraError: pi has no SSE MCP transport, so it can't use the s server \(mcp\.sse\)/,
    )
    assert.throws(
      () =>
        AGENTS.pi.mcpServers({
          'my.docs': { transport: 'stdio', command: 'node', args: [], env: {} },
        }),
      /^InfraError: pi takes MCP server names of letters, digits, "_" and "-" only, so it can't use the my\.docs server: rename it$/,
    )
  })

  test("pi's edit results are file edits with the patch's line counts", () => {
    const events = normaliseStream(
      [
        {
          ms: 1,
          part: {
            type: 'tool-call',
            toolCallId: 'e',
            toolName: 'edit',
            input: { path: 'b.txt', edits: [] },
          },
        },
        {
          ms: 2,
          part: {
            type: 'tool-result',
            toolCallId: 'e',
            output: {
              output: 'ok',
              details: { patch: '--- b.txt\n+++ b.txt\n@@ -1,1 +1,2 @@\n-bee\n+bumble\n+hive\n' },
            },
          },
        },
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) => (e.type === 'file-edit' ? [e.path, e.kind, e.added, e.removed] : e.type)),
      [['b.txt', 'modify', 2, 1]],
    )
  })
})

describe('the Codex harness', () => {
  test('is plain data with its own cell id, and needs an OpenAI model id', () => {
    const h = codex({ model: 'gpt-5.6-luna' })
    assert.deepEqual(h, { kind: 'codex', model: 'gpt-5.6-luna' })
    assert.equal(harnessId(h), 'codex:gpt-5.6-luna')
    assert.throws(
      () => codex({ model: 'openai/gpt-5.6-luna' }),
      /codex\(\) needs an OpenAI model id, without a provider, since it runs on an OpenAI API key, e\.g\. codex\(\{ model: 'gpt-5\.6-luna' \}\)/,
    )
  })

  test('Codex reads rules from AGENTS.md and skills from .agents/skills and ~/.agents/skills', () => {
    const h = codex({ model: 'm' })
    assert.deepEqual(layoutOf(h), {
      rulesFile: 'AGENTS.md',
      workspaceSkillDir: CODEX_WORKSPACE_SKILLS_DIR,
      harnessSkillDir: CODEX_HOME_SKILLS_DIR,
    })
    assert.equal(imageHarness(h), 'codex')
    const config = resolveConfig({ harness: [h] }, '/p')
    assert.deepEqual(missingCredentials(config, {}), ['OPENAI_API_KEY'])
    assert.deepEqual(missingCredentials(config, { OPENAI_API_KEY: 'x' }), [])
  })

  test("Codex's key is brokered to the Responses API only, whose response names the served model", () => {
    assert.deepEqual(AGENTS.codex.endpoints, CODEX_ENDPOINTS)
    const b = brokeringFor(codex({ model: 'm' }))
    assert.equal(b?.credential, 'OPENAI_API_KEY')
    assert.deepEqual(b?.modelResponses, CODEX_ENDPOINTS)
    const served = (request: Parameters<ServedModel>[0]) => b?.servedModel?.(request)
    const at = { method: 'POST', host: 'api.openai.com', path: '/v1/responses' }
    assert.equal(
      served({ ...at, responseModel: 'gpt-5.4-mini-2026-03-17', responseEffort: 'medium' }),
      'gpt-5.4-mini-2026-03-17[effort=medium]',
    )
    assert.equal(served({ ...at, responseModel: 'gpt-4.1' }), 'gpt-4.1')
    assert.equal(served(at), undefined, 'a response that names no model')
    assert.equal(served({ ...at, path: '/v1/models', responseModel: 'x' }), undefined)
  })

  test("MCP servers go in Codex's config.toml shape; it has no SSE transport", () => {
    assert.deepEqual(
      AGENTS.codex.mcpServers({
        stamp: { transport: 'stdio', command: 'node', args: ['s.mjs'], env: { A: 'b' } },
        web: { transport: 'http', url: 'https://x.test/mcp', headers: { H: 'v' } },
      }),
      {
        stamp: { command: 'node', args: ['s.mjs'], env: { A: 'b' } },
        web: { url: 'https://x.test/mcp', http_headers: { H: 'v' } },
      },
    )
    assert.throws(
      () =>
        AGENTS.codex.mcpServers({ s: { transport: 'sse', url: 'https://x.test', headers: {} } }),
      /^InfraError: Codex has no SSE MCP transport, so it can't use the s server \(mcp\.sse\)/,
    )
  })

  test("Codex's file changes are file edits: an added file is created, an updated one modified", () => {
    const change = (id: string, toolName: string, path: string, kind: string) => [
      { ms: 1, part: { type: 'tool-call', toolCallId: id, toolName, input: { path } } },
      { ms: 2, part: { type: 'tool-result', toolCallId: id, output: { kind } } },
    ]
    const events = normaliseStream(
      [
        ...change('a', 'write', 'new.txt', 'add'),
        ...change('u', 'edit', 'notes.txt', 'update'),
        ...change('d', 'delete', 'old.txt', 'delete'),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) => (e.type === 'file-edit' ? [e.path, e.kind] : e.type)),
      [
        ['new.txt', 'create'],
        ['notes.txt', 'modify'],
        ['old.txt', 'delete'],
      ],
    )
  })
})

describe('harness effort', () => {
  test('effort is the value that CLI takes, folded into the default id', () => {
    assert.equal(
      harnessId(claudeCode({ model: 'claude-sonnet-5', effort: 'high' })),
      'claude-code:claude-sonnet-5[effort=high]',
    )
    assert.equal(
      harnessId(claudeCode({ model: 'claude-sonnet-5', effort: 'low' })),
      'claude-code:claude-sonnet-5[effort=low]',
    )
    assert.equal(
      harnessId(cursor({ model: 'grok-4.7', effort: 'high', params: { fast: 'true' } })),
      'cursor:grok-4.7[effort=high]',
    )
    assert.equal(harnessId(cursor({ model: 'composer-2.5' })), 'cursor:composer-2.5')
    assert.equal(
      harnessId(pi({ model: 'gemini-3.8-flash', effort: 'xhigh' })),
      'pi:gemini-3.8-flash[effort=xhigh]',
    )
    assert.equal(
      harnessId(codex({ model: 'gpt-5.6-luna', effort: 'ultra' })),
      'codex:gpt-5.6-luna[effort=ultra]',
    )
    assert.equal(
      harnessId(goose({ model: 'gemini-3.8-flash', effort: 'off' })),
      'goose:gemini-3.8-flash[effort=off]',
    )
    assert.equal(
      harnessId(antigravity({ model: 'gemini-3.8-flash', effort: 'max' })),
      'antigravity:gemini-3.8-flash[effort=max]',
    )
    assert.equal(
      harnessId(opencode({ model: 'openai/gpt-5.4-mini', effort: 'high' })),
      'opencode:gpt-5.4-mini[effort=high]',
    )
    assert.equal(harnessId(fakeHarness({ effort: 'high' })), 'fake[effort=high]')
    assert.equal(harnessId(fakeHarness({ effort: 'high', id: 'fake' })), 'fake')
    assert.throws(
      () => claudeCode({ model: 'claude-sonnet-5', effort: '' }),
      /claudeCode\(\{ effort \}\) is the value that CLI takes/,
    )
    assert.throws(
      () => cursor({ model: 'composer-2.5', effort: 3 as never }),
      /cursor\(\{ effort \}\) is the value that CLI takes/,
    )
    assert.equal(harnessEffort(claudeCode({ model: 'claude-sonnet-5', effort: 'high' })), 'high')
    assert.equal(harnessEffort(cursor({ model: 'composer-2.5' })), undefined)
    assert.equal(effortFromModelLabel('gpt-5.6-luna[effort=medium]'), 'medium')
    assert.equal(effortFromModelLabel('composer-2.5[fast=true]'), undefined)
    assert.equal(effortFromModelLabel('grok-4.7[reasoning_effort=high,fast=true]'), 'high')
    assert.equal(servedEffortOf(['composer-2.5[fast=true]', 'gpt-5.6-luna[effort=low]']), 'low')
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
    const t = new CursorSdkStreamTranslator({ workDir: '/reeval/workspace' })
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
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
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
 * The rules an agent's real adapter asks the sandbox for, given the auth reeval passes it, while the
 * host has `env` set (which the adapter must not read).
 */
async function adapterRules(kind: AgentKind, env: Record<string, string>, model = 'm') {
  return withHostEnv(env, async () => {
    const descriptor = { kind, model } as AgentHarnessDescriptor
    const agent = agentFor(descriptor)
    const adapter = await agent.adapter({ auth: agentAuth(agent), descriptor })
    const { session, rules } = recordingSession()
    await assert.rejects(
      adapter.doStart({ sessionId: 's', sandboxSession: session }),
      /stopped by the test/,
    )
    return rules
  })
}

/** Runs `fn` with only `env`'s host credentials set, then restores the host's. */
async function withHostEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env }
  for (const name of HOST_CREDENTIALS) delete process.env[name]
  Object.assign(process.env, env)
  try {
    return await fn()
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
    await withHostEnv({ GEMINI_API_KEY: 'AIza-real' }, async () => {
      const agent = AGENTS.antigravity
      const adapter = await agent.adapter({
        auth: agentAuth(agent),
        descriptor: antigravity({ model: 'm' }),
      })
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
    })
  })

  test("OpenCode's adapter brokers only the model's provider's key, to its API, whatever else the host has", async () => {
    const google = await adapterRules(
      'opencode',
      {
        ...everything,
        GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real',
        GEMINI_API_KEY: 'host-gemini',
        GOOGLE_API_KEY: 'host-google',
      },
      'google/gemini-3.8-flash',
    )
    assert.equal(google.length, 1)
    assert.equal(google[0]?.match.host, 'generativelanguage.googleapis.com')
    assert.deepEqual(google[0]?.transform.headers, { 'x-goog-api-key': 'AIza-real' })
    const anthropic = await adapterRules(
      'opencode',
      { ...everything, ANTHROPIC_API_KEY: 'sk-ant-real' },
      'anthropic/claude-haiku-4-5',
    )
    assert.equal(anthropic.length, 1)
    assert.equal(anthropic[0]?.match.host, 'api.anthropic.com')
    assert.deepEqual(anthropic[0]?.transform.headers, { 'x-api-key': 'sk-ant-real' })
    const openai = await adapterRules(
      'opencode',
      { ...everything, OPENAI_API_KEY: 'sk-real' },
      'openai/gpt-5.4-mini',
    )
    assert.equal(openai.length, 1)
    assert.equal(openai[0]?.match.host, 'api.openai.com')
    assert.match(String(openai[0]?.match.headers?.[0]?.value?.exact), /^Bearer aisdkhc_/)
    assert.deepEqual(openai[0]?.transform.headers, { authorization: 'Bearer sk-real' })
    const bedrock = await adapterRules(
      'opencode',
      { ...everything, AWS_BEARER_TOKEN_BEDROCK: 'ABSK-real', AWS_REGION: 'eu-west-1' },
      'amazon-bedrock/global.anthropic.claude-haiku-4-5',
    )
    assert.deepEqual(
      bedrock.map((r) => [r.match.host, r.transform.headers]),
      [
        ['bedrock-mantle.eu-west-1.api.aws', { authorization: 'Bearer ABSK-real' }],
        ['bedrock-runtime.eu-west-1.amazonaws.com', { authorization: 'Bearer ABSK-real' }],
      ],
    )
  })

  test("the key is swapped in on OpenCode's model endpoint only; anything else is refused", async () => {
    const brokering = brokeringFor(opencode({ model: 'google/m' }))
    assert.equal(brokering?.credential, 'GOOGLE_GENERATIVE_AI_API_KEY')
    const rules = await adapterRules(
      'opencode',
      { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' },
      'google/m',
    )
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
    await withHostEnv({ GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' }, async () => {
      const descriptor = opencode({ model: 'google/m' })
      const agent = agentFor(descriptor)
      const adapter = await agent.adapter({ auth: agentAuth(agent), descriptor })
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
    })
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
    await withHostEnv({ GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' }, async () => {
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
    })
  })

  test("pi's adapter brokers only the Gemini key, as GEMINI_API_KEY, to the Gemini API", async () => {
    const rules = await adapterRules('pi', {
      ...everything,
      GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real',
      GEMINI_API_KEY: 'host-gemini',
    })
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.match.host, 'generativelanguage.googleapis.com')
    assert.deepEqual(rules[0]?.transform.headers, { 'x-goog-api-key': 'AIza-real' })
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
    // OpenCode's outputs: its content's text, with its ACP rawOutput's metadata.
    const events = normaliseStream(
      [
        call('w', 'write', { path: '/reeval/workspace/b.txt', content: 'bee\nsting\n' }),
        result('w', { output: 'Created file successfully: b.txt', metadata: {} }),
        call('o', 'write', { path: 'b.txt', content: 'bee\n' }),
        result('o', { output: 'Wrote file successfully: b.txt', metadata: {} }),
        call('e', 'edit', { path: '/reeval/workspace/src/a.ts', oldString: 'a', newString: 'b' }),
        result('e', {
          output: 'Edited src/a.ts (1 replacement)',
          metadata: {
            files: [{ file: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
          },
        }),
        call('x', 'edit', { path: 'c.ts', oldString: 'a', newString: 'b' }),
        result('x', { output: 'Edited c.ts', metadata: {} }),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) => (e.type === 'file-edit' ? [e.path, e.kind, e.added, e.removed] : e.type)),
      [
        ['b.txt', 'create', 2, 0],
        ['b.txt', 'modify', null, null],
        ['src/a.ts', 'modify', 2, 1],
        ['c.ts', 'modify', null, null],
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
        call('w', 'write', { file_path: '/reeval/workspace/greet.js', content: 'hi\n' }),
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
        ['file-edit', '/reeval/workspace/greet.js'],
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
        call('u', 'write', { file_path: '/reeval/workspace/notes.md', content: 'a\nb\n' }),
        result('u', {
          type: 'update',
          filePath: '/reeval/workspace/notes.md',
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
        ['/reeval/workspace/notes.md', 'modify', 1, 0],
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
        call('w', 'write', {
          TargetFile: '/reeval/workspace/a.txt',
          file_path: '/reeval/workspace/a.txt',
        }),
        result('w', null),
        call('e', 'edit', {
          TargetFile: '/reeval/workspace/a.txt',
          file_path: '/reeval/workspace/a.txt',
        }),
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
        ['file-edit', '/reeval/workspace/a.txt', 'modify'],
        ['file-edit', '/reeval/workspace/a.txt', 'modify'],
        ['tool', 'bash', 'hi\nthere\n', true],
        ['web-search', 'antigravity cli'],
        ['web-fetch', 'https://example.com', true],
        ['tool', 'read', 'stat /nope.txt: no such file', false],
      ],
    )
  })
})

describe('a failed tool call keeps its error', () => {
  const failed = (error: unknown) =>
    normaliseStream(
      [
        { ms: 10, part: { type: 'tool-call', toolCallId: 'w', toolName: 'write', input: {} } },
        { ms: 20, part: { type: 'tool-error', toolCallId: 'w', error } },
      ],
      0,
    ).flatMap((e) => (e.type === 'tool' ? [[e.output, e.ok]] : []))

  test("OpenCode's ACP rawOutput, `{ error }`", () => {
    // A write outside the workspace, as the unprivileged sandbox user (a real contract turn).
    assert.deepEqual(failed({ error: 'PermissionDenied: FileSystem.writeFile (/codeword.txt)' }), [
      ['PermissionDenied: FileSystem.writeFile (/codeword.txt)', false],
    ])
  })

  test('an Error, a string, and a shape with no message, as JSON', () => {
    assert.deepEqual(failed(new Error('boom')), [['boom', false]])
    assert.deepEqual(failed('stat: no such file'), [['stat: no such file', false]])
    assert.deepEqual(failed({ code: 13 }), [['{"code":13}', false]])
  })
})

/**
 * A harness that emits `parts` for every turn, through a real HarnessAgent, as reeval drives it.
 * `stream` is the agent's `fullStream`, stamped as reeval stamps it for `normaliseStream`.
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
  try {
    return { usage: tokenUsage(await result.totalUsage), served, stream, text: await result.text }
  } catch {
    // A harness's `error` part fails the turn, as it fails reeval's; `stream` has it.
    return { usage: null, served, stream, text: null }
  }
}

describe("agy's retried model calls, through HarnessAgent and the normaliser", () => {
  /** A captured agy 1.2.11 turn through today's translator, with `edit` made to its NDJSON first. */
  const agyParts = (name: string, edit = (ndjson: string) => ndjson) => {
    const ndjson = readFileSync(
      new URL(`../../harness-antigravity/test/fixtures/${name}`, import.meta.url),
      'utf8',
    )
    const t = new AntigravityStreamTranslator({ turn: 1 })
    return [
      ...edit(ndjson)
        .split('\n')
        .flatMap((l) => t.push(l)),
      ...t.end({ exitCode: 0 }),
    ]
  }
  const of = <T extends TranscriptEvent['type']>(events: TranscriptEvent[], type: T) =>
    events.filter((e): e is Extract<TranscriptEvent, { type: T }> => e.type === type)

  test("a retry that answered: the turn's text and transcript hold its reply once, and a retry", async () => {
    // agy ends this real turn ERROR ("The stream was interrupted") though the retry answered; as
    // SUCCESS, the turn's text is what reeval records for it.
    const parts = agyParts('provider-retried.ndjson', (s) =>
      s.replace('"status":"ERROR"', '"status":"SUCCESS"'),
    )
    const { text, stream } = await turnThrough(parts)
    assert.equal(text, 'FINAL-ATTEMPT reply, whole.\n')
    const events = normaliseStream(stream, 0)
    assert.deepEqual(
      of(events, 'text').map((e) => e.text),
      ['FINAL-ATTEMPT reply, whole.\n'],
    )
    assert.deepEqual(
      of(events, 'retry').map((e) => e.message),
      ['A model call failed (error_message), and the agent retried it'],
    )
    // The retry isn't an error: the turn succeeded.
    assert.deepEqual(of(events, 'error'), [])
  })

  test("every call dropped mid-reply: eight retries and agy's error, no partial reply", async () => {
    const { text, stream } = await turnThrough(agyParts('provider-dropped-mid-stream.ndjson'))
    assert.equal(text, null)
    const events = normaliseStream(stream, 0)
    assert.deepEqual(of(events, 'text'), [])
    assert.equal(of(events, 'retry').length, 8)
    // The turn's error is still agy's, the first and only error event.
    assert.deepEqual(
      of(events, 'error').map((e) => e.message),
      ['There was a network issue connecting to the server, please try again.'],
    )
  })

  test("a call refused once (400) and not retried: the provider's error alone, no retry", async () => {
    const events = normaliseStream((await turnThrough(agyParts('provider-400.ndjson'))).stream, 0)
    assert.deepEqual(of(events, 'retry'), [])
    assert.deepEqual(
      of(events, 'error').map((e) => e.message),
      [
        'agent executor error: generating and executing: Error 400, Message: fake 400, Status: INVALID_ARGUMENT, Details: []',
      ],
    )
  })
})

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
    const t = new CursorSdkStreamTranslator({ workDir: '/reeval/workspace' })
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

  test('the SDK stream loses them before our first layer: its stream alone has none anywhere', async () => {
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
    // harness-claude-code 1.0.152's bridge (`mapUsage`) on a real Messages API usage block:
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

  test('OpenCode: ACP PromptResponse.usage as harness-acp maps it', async () => {
    // @ai-sdk/harness-acp 1.0.72's mapACPUsage, after OpenCode #52467 reports the turn.
    const acp = {
      inputTokens: { total: 33942, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 117, reasoning: 21 },
    }
    const { usage } = await turnThrough(finishWith(acp))
    assert.deepEqual(usage, {
      input: 33942,
      output: 117,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 21,
    })
  })

  test('a harness that reports neither records null for both', async () => {
    const none = cursorUsage(undefined)
    const { usage, served } = await turnThrough(finishWith(none))
    assert.equal(usage, null)
    assert.equal(formatUsage(usage), null)
    assert.equal(served, undefined)
  })
})
