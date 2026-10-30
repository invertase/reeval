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
  ANTIGRAVITY_BUILTIN_TOOLS,
  ANTIGRAVITY_HOME_SKILLS_DIR,
  ANTIGRAVITY_HOOK_EVENTS,
  ANTIGRAVITY_WORKSPACE_RULES_FILE,
  ANTIGRAVITY_WORKSPACE_SKILLS_DIR,
  AntigravityStreamTranslator,
  antigravityEndpoints,
  toUsage as antigravityUsage,
} from '@reeval/harness-antigravity'
import {
  CODEX_ENDPOINTS,
  CODEX_HOME_SKILLS_DIR,
  CODEX_MODEL_ENDPOINTS,
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
import { FX_HOME_SKILLS_DIR, FX_WORKSPACE_SKILLS_DIR } from '@reeval/harness-fx'
import {
  GOOSE_ENDPOINTS,
  GOOSE_HOME_SKILLS_DIR,
  GOOSE_WORKSPACE_SKILLS_DIR,
} from '@reeval/harness-goose'
import {
  GROK_ENDPOINTS,
  GROK_HOME_SKILLS_DIR,
  GROK_WORKSPACE_SKILLS_DIR,
  GrokBuildStreamTranslator,
} from '@reeval/harness-grok-build'
import {
  OPENCODE_HOME_SKILLS_DIR,
  OPENCODE_WORKSPACE_SKILLS_DIR,
  openCodeEndpoints,
  openCodeTurnUsage,
} from '@reeval/harness-opencode'
import { PI_ENDPOINTS, PI_HOME_SKILLS_DIR, PI_WORKSPACE_SKILLS_DIR } from '@reeval/harness-pi'
import {
  applyTransformations,
  BAKED_HARNESSES,
  bakedAdapter,
  hostAllowed,
  onEndpoint,
} from '@reeval/sandbox-docker'
import { calledTool, fetched, searched } from '../src/assert.ts'
import { malformedCredentials, missingCredentials, resolveConfig } from '../src/config.ts'
import { plannedEgress } from '../src/egress.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment } from '../src/environment.ts'
import { resolveGateway } from '../src/gateway/resolve.ts'
import { interactiveTools, observed, tokenUsage } from '../src/harness/agent.ts'
import {
  AGENTS,
  type AgentKind,
  acpMcpServers,
  agentAuth,
  agentFor,
  antigravityMcpServers,
  brokeringFor,
  claudeMcpServers,
  cursorHookMatcher,
  cursorMcpServers,
  gooseMcpServers,
  LAYOUTS,
  layoutOf,
  opencodeVars,
  type ServedModel,
} from '../src/harness/agents.ts'
import { noDefaultEffort, withDefaultEffort } from '../src/harness/default-effort.ts'
import { effortFromModelLabel, harnessEffort, servedEffortOf } from '../src/harness/effort.ts'
import { workspaceSkillDir } from '../src/harness/index.ts'
import { normalizeStream, type StampedPart } from '../src/harness/transcript.ts'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fakeHarness,
  fx,
  goose,
  grokBuild,
  opencode,
  pi,
} from '../src/harness.ts'
import { harnessId } from '../src/options.ts'
import { imageHarness } from '../src/sandbox/prepare.ts'
import type { AgentHarnessDescriptor, TranscriptEvent } from '../src/types.ts'
import { promptTokens, sumUsage, totalTokens } from '../src/usage.ts'
import { formatUsage } from '../src/view/model.ts'

describe('where each harness reads what the environment gives it', () => {
  test('rules, repo skills and home skills go where each CLI reads them, in its own image', () => {
    const home = (kind: string, dir: string) =>
      `.ai-sdk-harness/.harness-bootstrap/${kind}/implementation/home/${dir}`
    type Row = [
      h: AgentHarnessDescriptor,
      rules: string,
      repo: string,
      home: string,
      plugins: string,
    ]
    // `plugins` is the placement, then each plugin directory unpacked into the workspace.
    const expected: Record<AgentKind, Row> = {
      cursor: [
        cursor({ model: 'm' }),
        CURSOR_SDK_WORKSPACE_RULES_FILE,
        CURSOR_SDK_WORKSPACE_SKILLS_DIR,
        CURSOR_SDK_HOME_SKILLS_DIR,
        'flat rules=.cursor/rules agents=.cursor/agents commands=.cursor/commands',
      ],
      'claude-code': [
        claudeCode({ model: 'opus' }),
        'CLAUDE.md',
        '.claude/skills',
        '.claude/skills',
        'namespaced',
      ],
      antigravity: [
        antigravity({ model: 'm' }),
        ANTIGRAVITY_WORKSPACE_RULES_FILE,
        ANTIGRAVITY_WORKSPACE_SKILLS_DIR,
        ANTIGRAVITY_HOME_SKILLS_DIR,
        'namespaced',
      ],
      opencode: [
        opencode({ model: 'google/m' }),
        'AGENTS.md',
        OPENCODE_WORKSPACE_SKILLS_DIR,
        OPENCODE_HOME_SKILLS_DIR,
        'flat agents=.opencode/agents commands=.opencode/commands',
      ],
      goose: [
        goose({ model: 'm' }),
        'AGENTS.md',
        GOOSE_WORKSPACE_SKILLS_DIR,
        home('goose', GOOSE_HOME_SKILLS_DIR),
        'flat',
      ],
      fx: [
        fx({ model: 'm' }),
        'AGENTS.md',
        FX_WORKSPACE_SKILLS_DIR,
        home('fx', FX_HOME_SKILLS_DIR),
        'flat',
      ],
      'grok-build': [
        grokBuild({ model: 'm' }),
        'AGENTS.md',
        GROK_WORKSPACE_SKILLS_DIR,
        home('grok-build', GROK_HOME_SKILLS_DIR),
        'namespaced',
      ],
      pi: [
        pi({ model: 'm' }),
        'AGENTS.md',
        PI_WORKSPACE_SKILLS_DIR,
        PI_HOME_SKILLS_DIR,
        'flat commands=.pi/prompts',
      ],
      codex: [
        codex({ model: 'm' }),
        'AGENTS.md',
        CODEX_WORKSPACE_SKILLS_DIR,
        CODEX_HOME_SKILLS_DIR,
        'namespaced',
      ],
    }
    for (const [kind, [h, ...want]] of Object.entries(expected)) {
      const layout = layoutOf(h)
      const unpacked = Object.entries(layout.pluginUnpack ?? {})
        .filter(([, dir]) => typeof dir === 'string')
        .map(([part, dir]) => `${part}=${dir}`)
      assert.deepEqual(
        [
          layout.rulesFile,
          layout.workspaceSkillDir,
          layout.harnessSkillDir,
          [layout.pluginPlacement, ...unpacked].join(' '),
        ],
        want,
        kind,
      )
      assert.equal(workspaceSkillDir(h), layout.workspaceSkillDir, kind)
      assert.equal(imageHarness(h), kind)
    }
    assert.equal(workspaceSkillDir(fakeHarness()), '.agents/skills')
    assert.equal(imageHarness(fakeHarness()), 'cursor')
  })

  test("the catalog's endpoints are each adapter's", () => {
    assert.deepEqual(AGENTS.cursor.endpoints, cursorSdkEndpoints())
    assert.deepEqual(
      brokeringFor(opencode({ model: 'google/m' }))?.endpoints,
      openCodeEndpoints('google/m'),
    )
    assert.deepEqual(AGENTS.goose.endpoints, GOOSE_ENDPOINTS)
    assert.deepEqual(AGENTS['grok-build'].endpoints, GROK_ENDPOINTS)
    assert.deepEqual(AGENTS.pi.endpoints, PI_ENDPOINTS)
  })
})

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
      grokBuild({ model: 'm' }),
      fx({ model: 'm' }),
    ]) {
      const fake = fakeHarness({ layout: real.kind })
      assert.deepEqual(layoutOf(fake), layoutOf(real), real.kind)
      assert.equal(imageHarness(fake), imageHarness(real), real.kind)
    }
    assert.throws(
      () => fakeHarness({ layout: 'cline' as never }),
      /fakeHarness\(\{ layout \}\) is one of 'cursor', 'claude-code', 'antigravity', 'opencode', 'goose', 'pi', 'codex', 'fx', 'grok-build' \(got "cline"\)/,
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
        files: {
          transport: 'stdio',
          command: 'npx',
          args: ['mcp-files'],
          env: { ROOT: '/reeval' },
        },
        docs: {
          transport: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer t' },
        },
      }),
      {
        files: { type: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/reeval' } },
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

  test("gets MCP servers in the CLI's mcp_config.json shape (serverUrl, not url)", () => {
    assert.deepEqual(
      antigravityMcpServers({
        files: {
          transport: 'stdio',
          command: 'npx',
          args: ['mcp-files'],
          env: { ROOT: '/reeval' },
        },
        docs: { transport: 'sse', url: 'https://docs.example/sse', headers: { A: 'b' } },
      }),
      {
        files: { command: 'npx', args: ['mcp-files'], env: { ROOT: '/reeval' } },
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
      pluginPlacement: 'namespaced',
      pluginHookEvents: Object.keys(ANTIGRAVITY_HOOK_EVENTS),
    })
  })
})

describe('the OpenCode harness', () => {
  test('is plain data with its own cell id, and needs a <provider>/<model>', () => {
    const h = opencode({ model: 'google/gemini-3.8-flash' })
    assert.deepEqual(h, { kind: 'opencode', model: 'google/gemini-3.8-flash' })
    assert.equal(harnessId(h), 'opencode:gemini-3.8-flash')
    assert.equal(
      harnessId(opencode({ model: 'amazon-bedrock/global.anthropic.claude-haiku-4-5' })),
      'opencode:global.anthropic.claude-haiku-4-5',
    )
    for (const model of [undefined, '']) {
      assert.throws(
        () => opencode({ model } as never),
        /opencode\(\): needs a model, <provider>\/<model>, e\.g\. opencode\(\{ model: 'google\/gemini-3\.8-flash' \}\)/,
        String(model),
      )
    }
    assert.throws(
      () => opencode({ model: 'openrouter/openai/gpt-5.4' }),
      /^UsageError: opencode\(\): an openrouter\/… id would bypass the config's gateway list: write the model as 'openai\/gpt-5\.4' and add openrouter\(\) to gateway/,
    )
    assert.throws(
      () => opencode({ model: 'gemini-3.8-flash' }),
      /^UsageError: opencode\(\): an OpenCode model id names its provider, <provider>\/<model>/,
    )
  })

  test("direct() refuses a provider it can't broker; vercel() takes any <provider>/<model>", () => {
    const onDirect = (model: string) =>
      resolveGateway([{ kind: 'direct' }], opencode({ model }), 'evaluate("e")')
    assert.throws(
      () => onDirect('google-vertex/gemini-3.8-flash'),
      /\(direct: reeval can't run OpenCode on Vertex \(google-vertex\): it takes a service account/,
    )
    assert.throws(() => onDirect('nope/m'), /\(direct: OpenCode has no provider "nope"/)
    const vertex = opencode({ model: 'google-vertex/x' })
    assert.equal(resolveGateway([{ kind: 'vercel' }], vertex, 'evaluate("e")').name, 'vercel')
  })

  test("needs only the model's provider's key", () => {
    const config = resolveConfig(
      {
        harness: [
          opencode({ model: 'google/m' }),
          opencode({ model: 'anthropic/claude-haiku-4-5' }),
          opencode({ model: 'cerebras/gpt-oss-120b', id: 'cb' }),
        ],
      },
      '/p',
    )
    assert.deepEqual(missingCredentials(config, { GEMINI_API_KEY: 'x' }), [
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'ANTHROPIC_API_KEY',
      'CEREBRAS_API_KEY',
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
        () => resolveGateway([{ kind: 'direct' }], bedrock, 'evaluate("e")'),
        /\(direct: AWS_REGION is "evil\.example\.com"/,
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
    assert.deepEqual(hosts('cerebras/m'), ['api.cerebras.ai', 'mcp.exa.ai'])
  })

  test("gets MCP servers in its config's shape, and refuses SSE", () => {
    assert.deepEqual(
      AGENTS.opencode.mcpServers({
        files: {
          transport: 'stdio',
          command: 'npx',
          args: ['mcp-files'],
          env: { ROOT: '/reeval' },
        },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: { type: 'local', command: ['npx', 'mcp-files'], environment: { ROOT: '/reeval' } },
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

  test('refuses an MCP value OpenCode would substitute, naming the server and field', () => {
    const refused = (server: Parameters<typeof AGENTS.opencode.mcpServers>[0][string]) => {
      try {
        AGENTS.opencode.mcpServers({ 'review:events': server })
        return undefined
      } catch (error) {
        return /wouldn't get (.+) as written/.exec((error as Error).message)?.[1]
      }
    }
    const stdio = (args: string[], env: Record<string, string> = {}) =>
      ({ transport: 'stdio', command: 'node', args, env }) as const
    assert.equal(refused(stdio(['a', '{file:/tmp/x}'])), 'mcp["review:events"].args[1]')
    assert.equal(
      refused(stdio([], { GREETING: 'Hello {env:USER}' })),
      'mcp["review:events"].env.GREETING',
    )
    assert.equal(refused(stdio(['{env:'])), 'mcp["review:events"].args[0]')
    assert.equal(
      refused({ transport: 'http', url: 'https://x.example/mcp', headers: { 'X-Key': '{env:K}' } }),
      'mcp["review:events"].headers["X-Key"]',
    )
    assert.equal(refused(stdio(['{env:}', '{file:}', '{ENV:X}', '{ env:X}'])), undefined)
  })

  test('refuses an MCP server, env or header name OpenCode would substitute, naming no value', () => {
    const refusal = (servers: Parameters<typeof AGENTS.opencode.mcpServers>[0]) => {
      try {
        AGENTS.opencode.mcpServers(servers)
        return undefined
      } catch (error) {
        return (error as Error).message
      }
    }
    const field = (servers: Parameters<typeof AGENTS.opencode.mcpServers>[0]) =>
      /wouldn't get (.+) as written/.exec(refusal(servers) ?? '')?.[1]
    const stdio = (env: Record<string, string> = {}) =>
      ({ transport: 'stdio', command: 'node', args: [], env }) as const
    assert.equal(field({ 'a{file:/etc/hostname}': stdio() }), 'its name')
    assert.equal(field({ 'p:{env:USER}': stdio() }), 'its name')
    assert.equal(
      field({ docs: stdio({ '{env:USER}': 'sk-live-1234' }) }),
      'the env name {env:USER} in mcp.docs.env',
    )
    assert.equal(field({ docs: stdio({ '{env:': 'X}' }) }), 'the env name {env: in mcp.docs.env')
    assert.equal(
      field({
        docs: { transport: 'http', url: 'https://x.example/mcp', headers: { 'X-{env:USER}': 's' } },
      }),
      'the header name X-{env:USER} in mcp.docs.headers',
    )
    assert.doesNotMatch(refusal({ docs: stdio({ '{env:USER}': 'sk-live-1234' }) }) ?? '', /sk-live/)
    assert.equal(field({ docs: stdio({ '{env:}': 'a', 'X_{file:}': 'b' }) }), undefined)
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

  test('gets MCP servers as Goose extensions (stdio and streamable_http), and refuses SSE', () => {
    assert.deepEqual(
      gooseMcpServers({
        files: {
          transport: 'stdio',
          command: 'npx',
          args: ['mcp-files'],
          env: { ROOT: '/reeval' },
        },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: { type: 'stdio', cmd: 'npx', args: ['mcp-files'], envs: { ROOT: '/reeval' } },
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

describe('the fx harness', () => {
  test('is plain data with its own cell id, and needs a model', () => {
    const h = fx({ model: 'gpt-4.1-mini' })
    assert.deepEqual(h, { kind: 'fx', model: 'gpt-4.1-mini' })
    assert.deepEqual(JSON.parse(JSON.stringify(h)), h)
    assert.equal(harnessId(h), 'fx:gpt-4.1-mini')
    assert.equal(harnessId(fx({ model: 'anthropic/claude-sonnet-5' })), 'fx:claude-sonnet-5')
    for (const model of [undefined, '']) {
      assert.throws(
        () => fx({ model } as never),
        /fx\(\) needs a model: a Vercel AI Gateway id, e\.g\. fx\(\{ model: 'anthropic\/claude-sonnet-5' \}\), or a bare OpenAI id/,
        String(model),
      )
    }
  })

  test('needs AI_GATEWAY_API_KEY for a gateway id, and OPENAI_API_KEY for a bare OpenAI id', () => {
    const gateway = resolveConfig({ harness: [fx({ model: 'anthropic/claude-sonnet-5' })] }, '/p')
    assert.deepEqual(missingCredentials(gateway, { OPENAI_API_KEY: 'x' }), ['AI_GATEWAY_API_KEY'])
    assert.deepEqual(missingCredentials(gateway, { AI_GATEWAY_API_KEY: 'x' }), [])
    const openai = resolveConfig({ harness: [fx({ model: 'gpt-4.1-mini' })] }, '/p')
    assert.deepEqual(missingCredentials(openai, { AI_GATEWAY_API_KEY: 'x' }), ['OPENAI_API_KEY'])
    assert.deepEqual(missingCredentials(openai, { OPENAI_API_KEY: 'x' }), [])
  })

  test("gets MCP servers in ACP's shape, a bare stdio command through env's PATH lookup", () => {
    assert.deepEqual(
      acpMcpServers({
        files: { transport: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/r' } },
        local: { transport: 'stdio', command: '/usr/bin/node', args: ['s.mjs'], env: {} },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: {
          command: '/usr/bin/env',
          args: ['npx', 'mcp-files'],
          env: [{ name: 'ROOT', value: '/r' }],
        },
        local: { command: '/usr/bin/node', args: ['s.mjs'], env: [] },
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: [{ name: 'A', value: 'b' }],
        },
      },
    )
  })
})

describe('the Grok Build harness', () => {
  test('is plain data with its own cell id, and needs an xAI model id', () => {
    const h = grokBuild({ model: 'grok-4.6' })
    assert.deepEqual(h, { kind: 'grok-build', model: 'grok-4.6' })
    assert.equal(harnessId(h), 'grok-build:grok-4.6')
    assert.equal(
      harnessId(grokBuild({ model: 'grok-4.6', effort: 'high' })),
      'grok-build:grok-4.6[effort=high]',
    )
    for (const model of [undefined, '', 'xai/grok-4.6']) {
      assert.throws(
        () => grokBuild({ model } as never),
        /grokBuild\(\) needs an xAI model id, without a provider, since it runs on an xAI API key, e\.g\. grokBuild\(\{ model: 'grok-4\.6' \}\)/,
        String(model),
      )
    }
  })

  test('is accepted by the config and needs XAI_API_KEY', () => {
    const config = resolveConfig({ harness: [grokBuild({ model: 'm' })] }, '/p')
    assert.deepEqual(missingCredentials(config, {}), ['XAI_API_KEY'])
    assert.deepEqual(missingCredentials(config, { XAI_API_KEY: 'x' }), [])
  })

  test("gets MCP servers in ACP's McpServer shape, as fx does", () => {
    assert.equal(AGENTS['grok-build'].mcpServers, acpMcpServers)
  })

  test("the served model is what each model call's response names, on api.x.ai only", () => {
    const brokering = brokeringFor(grokBuild({ model: 'grok-4.6' }))
    assert.equal(brokering?.credential, 'XAI_API_KEY')
    assert.deepEqual(
      brokering?.modelResponses?.map((e) => ('exact' in e.path ? e.path.exact : '')),
      ['/v1/chat/completions', '/v1/responses'],
    )
    const served = brokering?.servedModel
    const call = { method: 'POST', host: 'api.x.ai', path: '/v1/chat/completions' }
    assert.equal(served?.({ ...call, responseModel: 'grok-4.6-0709' }), 'grok-4.6-0709')
    assert.equal(served?.({ ...call, host: 'api.example', responseModel: 'x' }), undefined)
    assert.equal(served?.(call), undefined)
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
      'grok-build': {
        events: {
          type: 'sse',
          url: 'http://events.example/sse',
          headers: [{ name: 'A', value: 'b' }],
        },
      },
      fx: {
        events: {
          type: 'sse',
          url: 'http://events.example/sse',
          headers: [{ name: 'A', value: 'b' }],
        },
      },
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

  test('needs GOOGLE_GENERATIVE_AI_API_KEY, not GEMINI_API_KEY', () => {
    const config = resolveConfig({ harness: [pi({ model: 'm' })] }, '/p')
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
    const events = normalizeStream(
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

  test("pi's edit counts lines that start with -- or ++, and not the patch's file headers", () => {
    const edit = (patch: string) =>
      normalizeStream(
        [
          {
            ms: 1,
            part: {
              type: 'tool-call',
              toolCallId: 'e',
              toolName: 'edit',
              input: { path: 'q.sql' },
            },
          },
          {
            ms: 2,
            part: {
              type: 'tool-result',
              toolCallId: 'e',
              output: { output: 'ok', details: { patch } },
            },
          },
        ],
        0,
      ).map((e) => (e.type === 'file-edit' ? [e.added, e.removed] : e.type))
    assert.deepEqual(
      edit('--- q.sql\n+++ q.sql\n@@ -1,2 +1,2 @@\n--- old\n+++counter;\n select 1;\n'),
      [[1, 1]],
    )
    assert.deepEqual(edit('--- a.md\n+++ a.md\n@@ -1,3 +1,2 @@\n title\n----\n body\n'), [[0, 1]])
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

  test('needs OPENAI_API_KEY', () => {
    const config = resolveConfig({ harness: [codex({ model: 'm' })] }, '/p')
    assert.deepEqual(missingCredentials(config, {}), ['OPENAI_API_KEY'])
    assert.deepEqual(missingCredentials(config, { OPENAI_API_KEY: 'x' }), [])
  })

  test("Codex's key is brokered to the Responses API and its web search, and the Responses API names the served model", () => {
    assert.deepEqual(AGENTS.codex.endpoints, CODEX_ENDPOINTS)
    const b = brokeringFor(codex({ model: 'm' }))
    assert.equal(b?.credential, 'OPENAI_API_KEY')
    assert.deepEqual(
      b?.endpoints.map((e) => [e.method, e.host, e.path]),
      [
        [['POST'], 'api.openai.com', { exact: '/v1/responses' }],
        [['POST'], 'api.openai.com', { exact: '/v1/alpha/search' }],
      ],
    )
    assert.deepEqual(b?.modelResponses, CODEX_MODEL_ENDPOINTS)
    const on = (method: string, path: string, host = 'api.openai.com') =>
      onEndpoint(b?.endpoints ?? [], { method, host, path, headers: {} })
    assert.ok(on('POST', '/v1/responses') && on('POST', '/v1/alpha/search'))
    for (const [method, path, host] of [
      ['GET', '/v1/alpha/search'],
      ['POST', '/v1/alpha/searchX'],
      ['POST', '/v1/alpha/search/'],
      ['POST', '/v1/alpha/search/../files'],
      ['POST', '/v1/files/../alpha/search'],
      ['POST', '/v1/files/%2e%2e/alpha/search'],
      ['POST', '/v1/files'],
      ['POST', '/v1/alpha/search', 'api.openai.com.evil.example'],
    ]) {
      assert.equal(on(method, path, host), false, `${method} ${host ?? ''}${path}`)
    }
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
    const events = normalizeStream(
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
      () => claudeCode({ model: 'claude-sonnet-5', effort: 'nope' }),
      /claudeCode\(\{ effort \}\) must be low, medium, high, xhigh or max/,
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
    assert.equal(
      effortFromModelLabel('gpt-5.6-luna[context=1m,reasoning=medium,fast=false]'),
      'medium',
    )
    assert.equal(effortFromModelLabel('claude-opus-5[thinking=true]'), undefined)
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
      /cursor\(\{ params \}\) values are strings, as Cursor's model catalog lists them: write fast: 'false', not fast: false/,
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

  test("unpacks a plugin's hooks into .cursor/hooks.json, for every event the SDK runs", () => {
    const unpack = LAYOUTS.cursor.pluginUnpack
    assert.equal(unpack?.hooks?.file, '.cursor/hooks.json')
    assert.equal(unpack?.hooks?.matcher, cursorHookMatcher)
    assert.deepEqual(LAYOUTS.cursor.pluginHookEvents, [
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'SubagentStop',
      'PreCompact',
      'Stop',
    ])
    assert.deepEqual(Object.keys(unpack?.hooks?.events ?? {}), LAYOUTS.cursor.pluginHookEvents)
  })

  test("gets MCP servers in the SDK's McpServerConfig shape", () => {
    assert.deepEqual(
      cursorMcpServers({
        files: {
          transport: 'stdio',
          command: 'npx',
          args: ['mcp-files'],
          env: { ROOT: '/reeval' },
        },
        docs: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      }),
      {
        files: { type: 'stdio', command: 'npx', args: ['mcp-files'], env: { ROOT: '/reeval' } },
        docs: { type: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      },
    )
  })

  test('a real turn normalizes: relative edits, mcp__ names, timed tools', () => {
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
    const events = normalizeStream(parts as never, Date.parse('2026-09-26T12:00:00.000Z'))
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
    defaultWorkingDirectory: '/reeval',
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
  'OPENAI_API_KEY',
  'XAI_API_KEY',
]

/**
 * The rules an agent's real adapter asks the sandbox for, given the auth reeval passes it, while the
 * host has `env` set (which the adapter must not read).
 */
async function adapterRules(kind: AgentKind, env: Record<string, string>, model = 'm') {
  return withHostEnv(env, async () => {
    const descriptor = { kind, model } as AgentHarnessDescriptor
    const agent = agentFor(descriptor)
    const adapter = await agent.adapter({
      auth: agentAuth(agent),
      descriptor,
      model: descriptor.model,
      plugins: [],
    })
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
  const everything = {
    ANTHROPIC_API_KEY: 'sk-ant-real-key-for-tests',
    ANTHROPIC_AUTH_TOKEN: 'host-token',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
    AI_GATEWAY_API_KEY: 'host-gateway',
  }
  const gemini = 'generativelanguage.googleapis.com'
  const placeholderOf = (rule: HarnessV1RequestTransformation | undefined) =>
    String(rule?.match.headers?.[0]?.value?.exact ?? 'missing')

  // Each adapter, with every other credential the host might have set, asks for one rule per host:
  // its own key, in its own header, to its own API (never a host proxy or the AI Gateway).
  const ONLY: {
    name: string
    kind: AgentKind
    model?: string
    env: Record<string, string>
    credential: string
    rules: [host: string, headers: Record<string, string>][]
  }[] = [
    {
      name: 'Claude Code: the API key to Anthropic',
      kind: 'claude-code',
      env: everything,
      credential: 'ANTHROPIC_API_KEY',
      rules: [['api.anthropic.com', { 'x-api-key': 'sk-ant-real-key-for-tests' }]],
    },
    {
      name: 'Cursor: the API key to its exchange',
      kind: 'cursor',
      env: { ...everything, CURSOR_API_KEY: 'crsr_real' },
      credential: 'CURSOR_API_KEY',
      rules: [['api2.cursor.sh', { Authorization: 'Bearer crsr_real' }]],
    },
    {
      name: 'Antigravity: GEMINI_API_KEY to the Gemini API',
      kind: 'antigravity',
      env: {
        ...everything,
        GEMINI_API_KEY: 'AIza-real',
        GOOGLE_API_KEY: 'host-google',
        GOOGLE_GENERATIVE_AI_API_KEY: 'host-judge',
        GOOGLE_GEMINI_BASE_URL: 'https://proxy.example',
      },
      credential: 'GEMINI_API_KEY',
      rules: [[gemini, { 'x-goog-api-key': 'AIza-real' }]],
    },
    {
      name: "OpenCode: the model's provider's key, Google's",
      kind: 'opencode',
      model: 'google/gemini-3.8-flash',
      env: {
        ...everything,
        GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real',
        GEMINI_API_KEY: 'host-gemini',
        GOOGLE_API_KEY: 'host-google',
      },
      credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
      rules: [[gemini, { 'x-goog-api-key': 'AIza-real' }]],
    },
    {
      name: "OpenCode: the model's provider's key, Anthropic's",
      kind: 'opencode',
      model: 'anthropic/claude-haiku-4-5',
      env: { ...everything, ANTHROPIC_API_KEY: 'sk-ant-real' },
      credential: 'ANTHROPIC_API_KEY',
      rules: [['api.anthropic.com', { 'x-api-key': 'sk-ant-real' }]],
    },
    {
      name: "OpenCode: the model's provider's key, OpenAI's, as a Bearer token",
      kind: 'opencode',
      model: 'openai/gpt-5.4-mini',
      env: { ...everything, OPENAI_API_KEY: 'sk-real' },
      credential: 'OPENAI_API_KEY',
      rules: [['api.openai.com', { authorization: 'Bearer sk-real' }]],
    },
    {
      name: "OpenCode: Bedrock's key to AWS_REGION's hosts",
      kind: 'opencode',
      model: 'amazon-bedrock/global.anthropic.claude-haiku-4-5',
      env: { ...everything, AWS_BEARER_TOKEN_BEDROCK: 'ABSK-real', AWS_REGION: 'eu-west-1' },
      credential: 'AWS_BEARER_TOKEN_BEDROCK',
      rules: [
        ['bedrock-mantle.eu-west-1.api.aws', { authorization: 'Bearer ABSK-real' }],
        ['bedrock-runtime.eu-west-1.amazonaws.com', { authorization: 'Bearer ABSK-real' }],
      ],
    },
    {
      name: 'Goose: the Gemini key, as GOOGLE_API_KEY, to the Gemini API',
      kind: 'goose',
      env: {
        ...everything,
        GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real',
        GOOGLE_API_KEY: 'host-google',
        GEMINI_API_KEY: 'host-gemini',
      },
      credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
      rules: [[gemini, { 'x-goog-api-key': 'AIza-real' }]],
    },
    {
      name: 'fx: a bare id’s OpenAI key, as a Bearer token, to OpenAI',
      kind: 'fx',
      model: 'gpt-4.1-mini',
      env: { ...everything, OPENAI_API_KEY: 'sk-real' },
      credential: 'OPENAI_API_KEY',
      rules: [['api.openai.com', { Authorization: 'Bearer sk-real' }]],
    },
    {
      name: 'fx: a gateway id’s AI Gateway key, as a Bearer token, to the AI Gateway',
      kind: 'fx',
      model: 'anthropic/claude-sonnet-5',
      env: { ...everything, OPENAI_API_KEY: 'sk-real', AI_GATEWAY_API_KEY: 'vck-real' },
      credential: 'AI_GATEWAY_API_KEY',
      rules: [['ai-gateway.vercel.sh', { Authorization: 'Bearer vck-real' }]],
    },
    {
      name: 'Grok Build: the xAI key, on Authorization, to the xAI API',
      kind: 'grok-build',
      env: { ...everything, XAI_API_KEY: 'xai-real' },
      credential: 'XAI_API_KEY',
      rules: [['api.x.ai', { Authorization: 'Bearer xai-real' }]],
    },
    {
      name: 'pi: the Gemini key, as GEMINI_API_KEY, to the Gemini API',
      kind: 'pi',
      env: {
        ...everything,
        GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real',
        GEMINI_API_KEY: 'host-gemini',
      },
      credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
      rules: [[gemini, { 'x-goog-api-key': 'AIza-real' }]],
    },
  ]
  for (const row of ONLY) {
    test(`each adapter brokers only its key, whatever else the host has: ${row.name}`, async () => {
      const descriptor = { kind: row.kind, model: row.model ?? 'm' } as AgentHarnessDescriptor
      assert.equal(brokeringFor(descriptor)?.credential, row.credential)
      const rules = await adapterRules(row.kind, row.env, descriptor.model)
      assert.deepEqual(
        rules.map((r) => [r.match.host, r.transform.headers]),
        row.rules,
      )
      for (const rule of rules) assert.match(placeholderOf(rule), /^(Bearer )?aisdkhc_/)
    })
  }

  // The real key goes in only on the requests the agent makes with it, on the catalog's endpoints;
  // any other request with the placeholder keeps the placeholder.
  const ENDPOINTS: {
    name: string
    kind: AgentKind
    model?: string
    env: Record<string, string>
    header: string
    real: string
    host: string
    swapped: [method: string, path: string][]
    refused: [method: string, path: string, host?: string][]
  }[] = [
    {
      name: 'Claude Code',
      kind: 'claude-code',
      model: 'opus',
      env: { ANTHROPIC_API_KEY: 'sk-ant-real' },
      header: 'x-api-key',
      real: 'sk-ant-real',
      host: 'api.anthropic.com',
      swapped: [
        ['POST', '/v1/messages?beta=true'],
        ['POST', '/v1/messages/count_tokens'],
        ['GET', '/api/claude_code/settings'],
        ['GET', '/api/claude_code/policy_limits'],
      ],
      refused: [
        ['GET', '/v1/models'],
        ['POST', '/v1/files'],
        ['POST', '/v1/messages/batches'],
        ['GET', '/v1/messages'],
        ['POST', '/api/event_logging/v2/batch'],
        ['GET', '/api/claude_cli/bootstrap'],
        ['POST', '/api/eval/sdk-zAZezfDKGoZuXXKe'],
      ],
    },
    {
      name: 'Antigravity',
      kind: 'antigravity',
      env: { GEMINI_API_KEY: 'AIza-real' },
      header: 'x-goog-api-key',
      real: 'AIza-real',
      host: gemini,
      swapped: [
        ['POST', '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'],
        ['POST', '/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent?alt=sse'],
        ['POST', '/v1beta/models/gemini-3.1-flash-lite-preview:generateContent'],
      ],
      refused: [
        ['GET', '/v1beta/models'],
        ['GET', '/v1beta/models/gemini-3.8-flash:streamGenerateContent'],
        ['GET', '/v1beta/models/gemini-3.1-flash-lite-preview:generateContent'],
        ['POST', '/v1beta/models/gemini-3.8-flash:countTokens'],
        ['POST', '/v1beta/models/gemini-3.8-flash:countTokens:generateContent'],
        ['POST', '/v1beta/models/gemini-3.8-flash:generateContent/'],
        ['POST', '/v1beta/models/gemini-3.8-flash%3AgenerateContent'],
        ['POST', '/v1beta/models/x%2F..%2Ffiles:generateContent'],
        ['POST', '/v1beta/models/../files:generateContent'],
        ['POST', '/v1beta/models/gemini-3.8-flash:GenerateContent'],
        ['POST', '/v1beta/files'],
        ['POST', '/upload/v1beta/files'],
        ['POST', '/v1beta/cachedContents'],
      ],
    },
    {
      name: 'OpenCode',
      kind: 'opencode',
      model: 'google/m',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' },
      header: 'x-goog-api-key',
      real: 'AIza-real',
      host: gemini,
      swapped: [['POST', '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse']],
      refused: [
        ['GET', '/v1beta/models'],
        ['POST', '/v1beta/models/gemini-3.8-flash:generateContent'],
        ['POST', '/v1beta/files'],
      ],
    },
    {
      name: 'Cursor',
      kind: 'cursor',
      env: { CURSOR_API_KEY: 'crsr_real' },
      header: 'authorization',
      real: 'Bearer crsr_real',
      host: 'api2.cursor.sh',
      swapped: [['POST', '/auth/exchange_user_api_key']],
      refused: [],
    },
    {
      name: 'Grok Build',
      kind: 'grok-build',
      env: { XAI_API_KEY: 'xai-real' },
      header: 'authorization',
      real: 'Bearer xai-real',
      host: 'api.x.ai',
      swapped: [
        ['GET', '/v1/models'],
        ['GET', '/v1/api-key'],
        ['POST', '/v1/chat/completions'],
        ['POST', '/v1/responses'],
      ],
      refused: [
        ['POST', '/v1/models'],
        ['GET', '/v1/files'],
        ['POST', '/v1/chat/completions', 'evil.example'],
      ],
    },
  ]
  for (const row of ENDPOINTS) {
    test(`the key is swapped in on the agent's endpoints only: ${row.name}`, async () => {
      const descriptor = { kind: row.kind, model: row.model ?? 'm' } as AgentHarnessDescriptor
      const rules = await adapterRules(row.kind, row.env, descriptor.model)
      const placeholder = placeholderOf(rules[0])
      const send = (method: string, path: string, host = row.host) =>
        applyTransformations(
          rules,
          { host, method, path, headers: { [row.header]: placeholder } },
          brokeringFor(descriptor)?.endpoints,
        )
      for (const [method, path] of row.swapped) {
        assert.equal(send(method, path).headers[row.header], row.real, `${method} ${path}`)
      }
      for (const [method, path, host] of row.refused) {
        const r = send(method, path, host)
        assert.equal(r.headers[row.header], placeholder, `${method} ${host ?? row.host}${path}`)
        if (!host) assert.equal(r.refused, true, `${method} ${path}`)
      }
    })
  }

  test("Cursor's session tokens are tokenized at its exchange and swapped back on its hosts only", () => {
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

  // Each adapter pins its own refusal; this pins that reeval asks every one of them for it.
  test("every adapter reeval starts fails closed on a sandbox that can't broker: the key never goes in", async () => {
    const FAIL_CLOSED: [AgentHarnessDescriptor, Record<string, string>, string][] = [
      [cursor({ model: 'm' }), { CURSOR_API_KEY: 'crsr_real' }, 'CURSOR_API_KEY'],
      [antigravity({ model: 'm' }), { GEMINI_API_KEY: 'AIza-real' }, 'GEMINI_API_KEY'],
      [
        opencode({ model: 'google/m' }),
        { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' },
        'GOOGLE_GENERATIVE_AI_API_KEY',
      ],
      [goose({ model: 'm' }), { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' }, 'GOOGLE_API_KEY'],
      [pi({ model: 'm' }), { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-real' }, 'GEMINI_API_KEY'],
      [codex({ model: 'm' }), { OPENAI_API_KEY: 'sk-real' }, 'OPENAI_API_KEY'],
      [fx({ model: 'gpt-4.1-mini' }), { OPENAI_API_KEY: 'sk-real' }, 'OPENAI_API_KEY'],
      [grokBuild({ model: 'm' }), { XAI_API_KEY: 'xai-real' }, 'XAI_API_KEY'],
    ]
    for (const [descriptor, env, credential] of FAIL_CLOSED) {
      await withHostEnv(env, async () => {
        const agent = agentFor(descriptor)
        const adapter = await agent.adapter({
          auth: agentAuth(agent),
          descriptor,
          model: descriptor.model,
          plugins: [],
        })
        const { session } = recordingSession()
        const { addRequestTransformations: _, ...plain } = session
        let started = false
        const start = async () => {
          started = true
          throw new Error('started')
        }
        await assert.rejects(
          adapter.doStart({
            sessionId: 's',
            sandboxSession: { ...plain, run: start, spawn: start },
          }),
          new RegExp(`can't broker ${credential}`),
          descriptor.kind,
        )
        assert.equal(started, false, descriptor.kind)
      })
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
    // OpenCode's outputs: its content's text, with its ACP rawOutput's metadata.
    const events = normalizeStream(
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

describe('writes that say nothing of the file before', () => {
  test('a write is a write, counting its content; an edit stays a modify', () => {
    const call = (id: string, toolName: string, input: unknown) => ({
      ms: 10,
      part: { type: 'tool-call', toolCallId: id, toolName, input },
    })
    const result = (id: string, output: unknown) => ({
      ms: 20,
      part: { type: 'tool-result', toolCallId: id, output },
    })
    const events = normalizeStream(
      [
        call('p', 'write', { path: 'a.txt', content: 'one\ntwo\n' }),
        result('p', 'Successfully wrote to a.txt'),
        call('g', 'write', { path: 'b.txt' }),
        result('g', ''),
        call('e', 'edit', { path: 'c.txt', old_string: 'x', new_string: 'y' }),
        result('e', [{ type: 'content', content: { type: 'text', text: 'edited c.txt' } }]),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) => (e.type === 'file-edit' ? [e.path, e.kind, e.added, e.removed] : e.type)),
      [
        ['a.txt', 'write', 2, null],
        ['b.txt', 'write', null, null],
        ['c.txt', 'modify', null, null],
      ],
    )
  })

  test("Grok Build's write, named from its x.ai/tool metadata, is a write counting its content", () => {
    const t = new GrokBuildStreamTranslator()
    const rawInput = { file_path: '/reeval/workspace/a.txt', content: 'x\n' }
    const parts = [
      {
        type: 'raw',
        rawValue: {
          sessionUpdate: 'tool_call',
          toolCallId: 'w',
          title: 'write',
          rawInput,
          _meta: { 'x.ai/tool': { name: 'write', namespace: 'grok_build' } },
        },
      },
      {
        type: 'tool-call',
        toolCallId: 'w',
        toolName: 'acp_tool_w',
        input: JSON.stringify(rawInput),
      },
      { type: 'tool-result', toolCallId: 'w', toolName: 'acp_tool_w', output: 'File written' },
    ].map((p) => t.push(p))
    const call = parts.find((p) => p.type === 'tool-call')
    assert.equal(call?.toolName, 'write')
    const events = normalizeStream(
      parts
        .filter((p) => p.type !== 'raw')
        .map((part, i) => ({
          ms: 10 * (i + 1),
          part:
            part.type === 'tool-call' ? { ...part, input: JSON.parse(String(part.input)) } : part,
        })),
      0,
    )
    assert.deepEqual(
      events.map((e) => (e.type === 'file-edit' ? [e.path, e.kind, e.added, e.removed] : e.type)),
      [['/reeval/workspace/a.txt', 'write', 1, null]],
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
    const events = normalizeStream(
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
    const events = normalizeStream(
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
    const events = normalizeStream(
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
        call('f', 'WebFetch', { url: 'https://nodejs.org/api/test.html', prompt: 'summarize' }),
        result('f', {
          bytes: 10,
          code: 200,
          codeText: 'OK',
          result: 'x',
          durationMs: 5,
          url: 'https://nodejs.org/api/test.html',
        }),
        call('m', 'WebFetch', { url: 'https://example.com/missing', prompt: 'summarize' }),
        result('m', { code: 404, codeText: 'Not Found', url: 'https://example.com/missing' }),
        call('c', 'webSearch', { searchTerm: 'cursor search' }),
        result('c', { referenceCount: 3 }),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) =>
        e.type === 'web-search'
          ? [e.type, e.query, e.references, e.ok]
          : e.type === 'web-fetch'
            ? [e.type, e.url, e.ok]
            : [e.type],
      ),
      [
        ['web-search', 'node test runner', 2, true],
        ['web-fetch', 'https://nodejs.org/api/test.html', true],
        ['web-fetch', 'https://example.com/missing', false],
        ['web-search', 'cursor search', 3, true],
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

  test("its native tool shapes normalize like the other agents' (CLI 1.2.11)", () => {
    const events = normalizeStream(
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
            ? [e.type, e.query, e.ok]
            : e.type === 'web-fetch'
              ? [e.type, e.url, e.ok]
              : e.type === 'tool'
                ? [e.type, e.tool, e.output, e.ok]
                : [e.type],
      ),
      [
        ['file-edit', '/reeval/workspace/a.txt', 'write'],
        ['file-edit', '/reeval/workspace/a.txt', 'modify'],
        ['tool', 'bash', 'hi\nthere\n', true],
        ['web-search', 'antigravity cli', true],
        ['web-fetch', 'https://example.com', true],
        ['tool', 'read', 'stat /nope.txt: no such file', false],
      ],
    )
  })
})

describe('Cursor tool wall time when completed_at_ms is early', () => {
  test('durationMs follows the stream until the tool result, and marks long shells stalled', () => {
    const startedAt = Date.parse('2026-10-18T12:00:00.000Z')
    const events = normalizeStream(
      [
        { ms: 100, part: { type: 'tool-call', toolCallId: 'b', toolName: 'bash', input: {} } },
        {
          ms: 2_810_000,
          part: { type: 'tool-result', toolCallId: 'b', output: 'ok' },
        },
        {
          ms: 150,
          part: {
            type: 'raw',
            rawValue: {
              type: 'event',
              event: {
                type: 'tool_call',
                call_id: 'b',
                status: 'completed',
                started_at_ms: startedAt + 100,
                completed_at_ms: startedAt + 200,
              },
            },
          },
        },
      ],
      startedAt,
    )
    const bash = events.find((e) => e.type === 'tool' && e.tool === 'bash')
    assert.ok(bash && bash.type === 'tool')
    assert.equal(bash.durationMs, 2_809_900)
    assert.equal(bash.stalled, true)
  })
})

describe('a failed tool call keeps its error', () => {
  const failed = (error: unknown) =>
    normalizeStream(
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

describe('a refused webSearch is a web-search event', () => {
  const call = (id: string, toolName: string, input: unknown) => ({
    ms: 10,
    part: { type: 'tool-call' as const, toolCallId: id, toolName, input },
  })
  const ok = (id: string, output: unknown) => ({
    ms: 20,
    part: { type: 'tool-result' as const, toolCallId: id, output },
  })
  const err = (id: string, error: unknown) => ({
    ms: 20,
    part: { type: 'tool-error' as const, toolCallId: id, error },
  })
  const activity = (events: ReturnType<typeof normalizeStream>) => ({
    tools: events.filter((e) => e.type === 'tool').length,
    webSearches: events.filter((e) => e.type === 'web-search').length,
    webFetches: events.filter((e) => e.type === 'web-fetch').length,
  })
  const turnOf = (events: ReturnType<typeof normalizeStream>) => ({
    transcript: events,
    unreported: [] as Array<'web-search' | 'web-fetch'>,
  })

  test('a tool-error search is web-search with ok: false, not a generic tool', () => {
    const events = normalizeStream(
      [call('s', 'webSearch', { query: 'firebase ui web' }), err('s', '403 Forbidden')],
      0,
    )
    assert.deepEqual(
      events.map((e) =>
        e.type === 'web-search'
          ? [e.type, e.query, e.references, e.ok]
          : e.type === 'tool'
            ? [e.type, e.tool, e.ok]
            : [e.type],
      ),
      [['web-search', 'firebase ui web', null, false]],
    )
    assert.deepEqual(activity(events), { tools: 0, webSearches: 1, webFetches: 0 })
    const turn = turnOf(events)
    assert.equal(searched(turn).pass, true)
    assert.equal(searched(turn, 'firebase').pass, true)
    assert.equal(calledTool(turn, 'webSearch').pass, false)
  })

  test('a tool-error fetch stays web-fetch with ok: false', () => {
    const events = normalizeStream(
      [call('f', 'webFetch', { url: 'https://example.com' }), err('f', '403 Forbidden')],
      0,
    )
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'web-fetch' ? [[e.url, e.ok]] : [])),
      [['https://example.com', false]],
    )
    assert.equal(fetched(turnOf(events)).pass, true)
  })

  test('a successful search still has ok: true and its references', () => {
    const events = normalizeStream(
      [call('s', 'webSearch', { query: 'firebase ui web' }), ok('s', { referenceCount: 2 })],
      0,
    )
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'web-search' ? [[e.query, e.references, e.ok]] : [])),
      [['firebase ui web', 2, true]],
    )
  })

  test('a pending search (no result) is web-search with ok: null, not failed', () => {
    const events = normalizeStream([call('s', 'webSearch', { query: 'firebase ui web' })], 0)
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'web-search' ? [[e.query, e.references, e.ok]] : [])),
      [['firebase ui web', null, null]],
    )
    assert.deepEqual(activity(events), { tools: 0, webSearches: 1, webFetches: 0 })
    assert.equal(searched(turnOf(events), /firebase/).pass, true)
  })

  test('a pending fetch is web-fetch with ok: null, not failed', () => {
    const events = normalizeStream([call('f', 'webFetch', { url: 'https://example.com' })], 0)
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'web-fetch' ? [[e.url, e.ok]] : [])),
      [['https://example.com', null]],
    )
  })

  test('a pending tool call is a tool with ok: null and no output, and a failed one stays failed', () => {
    const events = normalizeStream(
      [
        { ...call('r', 'read', { path: 'notes.txt' }), ms: 5 },
        call('x', 'bash', { command: 'false' }),
        { ms: 30, part: { type: 'tool-error', toolCallId: 'x', error: 'exit 1' } },
      ],
      0,
    )
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'tool' ? [[e.tool, e.ok, e.output]] : [])),
      [
        ['read', null, null],
        ['bash', false, 'exit 1'],
      ],
    )
  })

  test("Antigravity's isError webSearch becomes a web-search event through HarnessAgent", async () => {
    const parts: HarnessV1StreamPart[] = [
      { type: 'stream-start' },
      {
        type: 'tool-call',
        toolCallId: 'agy-1',
        toolName: 'webSearch',
        input: JSON.stringify({ query: 'firebase ui web' }),
        providerExecuted: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'agy-1',
        toolName: 'webSearch',
        result: "blocked by the reeval egress policy: www.google.com isn't in the allowlist",
        isError: true,
      },
      {
        type: 'finish-step',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        totalUsage: { inputTokens: 1, outputTokens: 1 },
      },
    ]
    const { stream } = await turnThrough(parts, ANTIGRAVITY_BUILTIN_TOOLS)
    assert.ok(stream.some((s) => s.part.type === 'tool-error'))
    const events = normalizeStream(stream, 0)
    assert.deepEqual(
      events.flatMap((e) =>
        e.type === 'web-search' ? [[e.query, e.ok]] : e.type === 'tool' ? [[e.tool, e.ok]] : [],
      ),
      [['firebase ui web', false]],
    )
    assert.deepEqual(activity(events), { tools: 0, webSearches: 1, webFetches: 0 })
    assert.equal(searched(turnOf(events), 'firebase').pass, true)
  })
})

/**
 * A harness that emits `parts` for every turn, through a real HarnessAgent, as reeval drives it.
 * `stream` is the agent's `fullStream`, stamped as reeval stamps it for `normalizeStream`.
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
    defaultWorkingDirectory: '/reeval',
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

describe('tools that wait on a person are off', () => {
  test("only Claude Code offers one, and it's askUserQuestions", async () => {
    const descriptors: AgentHarnessDescriptor[] = [
      cursor({ model: 'composer-2.5' }),
      claudeCode({ model: 'claude-sonnet-5' }),
      antigravity({ model: 'gemini-3.8-flash' }),
      opencode({ model: 'google/gemini-3.8-flash' }),
      goose({ model: 'gemini-3.8-flash' }),
      pi({ model: 'gemini-3.8-flash' }),
      codex({ model: 'gpt-5.5' }),
      fx({ model: 'gpt-4.1' }),
      grokBuild({ model: 'grok-build' }),
    ]
    assert.deepEqual(
      new Set(descriptors.map((d) => d.kind)),
      new Set(Object.keys(AGENTS)),
      'every agent is checked',
    )
    const keys = Object.fromEntries(Object.values(AGENTS).map((a) => [a.credential, 'k']))
    await withHostEnv(keys, async () => {
      for (const descriptor of descriptors) {
        const agent = agentFor(descriptor)
        const adapter = await agent.adapter({
          auth: agentAuth(agent),
          descriptor,
          model: descriptor.model,
          plugins: [],
        })
        assert.deepEqual(
          interactiveTools(adapter as HarnessV1),
          descriptor.kind === 'claude-code' ? ['askUserQuestions'] : [],
          descriptor.kind,
        )
      }
    })
  })

  test('HarnessAgent hands the adapter a deny filter for them when the session starts', async () => {
    let filtering: unknown
    const adapter = {
      specificationVersion: 'harness-v1',
      harnessId: 'scripted',
      supportsBuiltinToolFiltering: true,
      builtinTools: { askUserQuestions: {}, read: {} },
      doStart: async (options: { sessionId: string; builtinToolFiltering?: unknown }) => {
        filtering = options.builtinToolFiltering
        return { sessionId: options.sessionId, isResume: false, doDestroy: async () => {} }
      },
    } as unknown as HarnessV1
    const off = interactiveTools(adapter)
    assert.deepEqual(off, ['askUserQuestions'])
    const agent = new HarnessAgent({
      harness: adapter,
      model: 'm',
      permissionMode: 'allow-all',
      inactiveTools: off as never,
    })
    const sandboxSession = {
      description: 'none',
      defaultWorkingDirectory: '/reeval',
      run: async () => ({ exitCode: 0, stdout: '/root', stderr: '' }),
      restricted: () => sandboxSession,
    }
    await agent.createSession({ sandboxSession: sandboxSession as never })
    assert.deepEqual(filtering, { mode: 'deny', toolNames: ['askUserQuestions'] })
  })
})

describe("agy's retried model calls, through HarnessAgent and the normalizer", () => {
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
    const events = normalizeStream(stream, 0)
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
    const events = normalizeStream(stream, 0)
    assert.deepEqual(of(events, 'text'), [])
    assert.equal(of(events, 'retry').length, 8)
    // The turn's error is still agy's, the first and only error event.
    assert.deepEqual(
      of(events, 'error').map((e) => e.message),
      ['There was a network issue connecting to the server, please try again.'],
    )
  })

  test("a call refused once (400) and not retried: the provider's error alone, no retry", async () => {
    const events = normalizeStream((await turnThrough(agyParts('provider-400.ndjson'))).stream, 0)
    assert.deepEqual(of(events, 'retry'), [])
    assert.deepEqual(
      of(events, 'error').map((e) => e.message),
      [
        'agent executor error: generating and executing: Error 400, Message: fake 400, Status: INVALID_ARGUMENT, Details: []',
      ],
    )
  })
})

describe('Cursor web tools at every layer: SDK, adapter, HarnessAgent, normalizer', () => {
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
    const events = normalizeStream(stream, startedAt).filter(
      (e) => e.type === 'web-search' || e.type === 'web-fetch',
    )
    return { sdk, adapter, agent, events }
  }

  test('web calls the runner recovers survive the adapter, HarnessAgent and the normalizer', async () => {
    const startedAt = 1790444242000
    const { sdk, adapter, agent, events } = await layers('web-recovered.ndjson', startedAt)
    assert.deepEqual(sdk, ['webFetch', 'webSearch'])
    assert.deepEqual(adapter, sdk, 'the adapter maps both to provider-executed builtins')
    assert.deepEqual(agent, sdk, 'HarnessAgent passes provider-executed builtins on')
    // Placed and timed by the backend's own clock, though reported after the turn.
    assert.deepEqual(
      events.map((e) =>
        e.type === 'web-search'
          ? [e.type, e.query, e.references, e.ok, e.atMs, e.durationMs]
          : [e.type, e.url, e.ok, e.atMs, e.durationMs],
      ),
      [
        ['web-search', 'IANA example domain RFC 2606', 2, true, 461, 4042],
        ['web-fetch', 'https://httpbin.org/ip', true, 467, 1242],
      ],
    )
  })

  test('a call the SDK never completed is unfinished through every layer, or recovered from the store', async () => {
    const startedAt = 1_790_000_000_000
    const read = (status: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'event',
        event: {
          type: 'tool_call',
          call_id: 'r',
          name: 'read',
          status,
          args: { path: '/reeval/workspace/notes.txt' },
          ...extra,
        },
      })
    const result = JSON.stringify({ type: 'result', status: 'finished', usage: { inputTokens: 1 } })
    const through = async (lines: string[]) => {
      const t = new CursorSdkStreamTranslator({ workDir: '/reeval/workspace' })
      const { stream } = await turnThrough(
        lines.flatMap((l) => t.push(l)),
        CURSOR_SDK_BUILTIN_TOOLS,
      )
      return normalizeStream(stream, startedAt).flatMap((e) =>
        e.type === 'tool' ? [[e.tool, e.ok, e.output, e.durationMs]] : [],
      )
    }
    assert.deepEqual(
      (await through([read('running'), result])).map((e) => e.slice(0, 3)),
      [['read', null, null]],
    )
    const recovered = JSON.stringify({
      ...JSON.parse(read('completed')),
      recovered: 'Agent.messages.list',
      event: {
        ...JSON.parse(read('completed')).event,
        result: { status: 'success', value: { content: 'alpha\n' } },
        started_at_ms: startedAt + 100,
        completed_at_ms: startedAt + 213,
      },
    })
    // Timed by the backend's clock, though its result arrived after the turn.
    assert.deepEqual(await through([read('running'), recovered, result]), [
      ['read', true, { content: 'alpha\n' }, 113],
    ])
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

  test("Antigravity: a three-turn attempt counts each turn's own calls once", async () => {
    // A real agy 1.4.4 conversation, one process per turn, each resuming the first. The Gemini
    // API's usageMetadata for its eight model calls sums to 66021 uncached prompt tokens,
    // 254217 cached and 413 output: what agy's last result reports as its running total.
    const turns = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const t = new AntigravityStreamTranslator({
          turn: n,
          conversationId: n === 1 ? undefined : '950c7d99-14bd-4d1b-844f-43bbb7c6fc18',
        })
        const ndjson = readFileSync(
          new URL(
            `../../harness-antigravity/test/fixtures/three-turns-${n}.ndjson`,
            import.meta.url,
          ),
          'utf8',
        )
        return (await turnThrough(ndjson.split('\n').flatMap((l) => t.push(l)))).usage
      }),
    )
    assert.deepEqual(sumUsage(turns), {
      input: 66021,
      output: 413,
      cacheRead: 254217,
      cacheWrite: 0,
      reasoning: 0,
    })
  })

  test('Cursor: the SDK input holds the cache reads, so uncached input is what is left', async () => {
    const sdk = cursorUsage({
      inputTokens: 15564 + 10464,
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

  test("Cursor: a turn's tokens are what Cursor's usage export billed for it", async () => {
    // Three composer-2.5[fast=false] attempts on @cursor/sdk 1.0.40: each row of Cursor's usage
    // export (uncached input, cache read, output, total) next to the SDK's usage for that run.
    // The SDK's totalTokens counts the cache reads twice, so it isn't the billed total.
    const rows = [
      { noCache: 45192, cacheRead: 900877, output: 8350, billed: 954419, sdkInput: 946069 },
      { noCache: 73902, cacheRead: 747700, output: 7584, billed: 829186, sdkInput: 821602 },
      { noCache: 5250, cacheRead: 151095, output: 5057, billed: 161402, sdkInput: 156345 },
    ]
    for (const row of rows) {
      const sdk = cursorUsage({
        inputTokens: row.sdkInput,
        outputTokens: row.output,
        cacheReadTokens: row.cacheRead,
        cacheWriteTokens: 0,
        totalTokens: row.sdkInput + row.output + row.cacheRead,
      })
      const { usage } = await turnThrough(finishWith(sdk))
      assert.ok(usage)
      assert.equal(usage.input, row.noCache)
      assert.equal(usage.cacheRead, row.cacheRead)
      assert.equal(usage.output, row.output)
      assert.equal(promptTokens(usage) + usage.output, row.billed)
    }
  })

  test('Claude Code: the API usage its bridge maps, cache creation as cache writes', async () => {
    // harness-claude-code 1.0.160's bridge (`mapUsage`) on a real Messages API usage block:
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

  test('OpenCode: ACP PromptResponse.usage with its thoughts added to the output', async () => {
    // test/replay/opencode/skill: inputTokens 4864, outputTokens 1, thoughtTokens 31,
    // totalTokens 4896, as harness-acp maps it and openCodeTurnUsage adds the thoughts.
    const acp = openCodeTurnUsage({
      inputTokens: { total: 4864, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, reasoning: 31 },
      raw: { totalTokens: 4896, inputTokens: 4864, outputTokens: 1, thoughtTokens: 31 },
    })
    const { usage } = await turnThrough(finishWith(acp))
    assert.deepEqual(usage, {
      input: 4864,
      output: 32,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 31,
    })
    assert.ok(usage)
    assert.equal(totalTokens(usage), 4896, "OpenCode's own total, reasoning counted once")
  })

  test('a harness that reports neither records null for both', async () => {
    const none = cursorUsage(undefined)
    const { usage, served } = await turnThrough(finishWith(none))
    assert.equal(usage, null)
    assert.equal(formatUsage(usage), null)
    assert.equal(served, undefined)
  })
})

describe("each harness's image serves its attempts' bootstrap", () => {
  // An attempt that asks for another bootstrap than its image baked reinstalls the CLI at start,
  // where a restricted egress policy refuses the download.
  const ATTEMPTS: Record<(typeof BAKED_HARNESSES)[number], readonly AgentHarnessDescriptor[]> = {
    cursor: [cursor({ model: 'composer-2.5' })],
    'claude-code': [claudeCode({ model: 'claude-sonnet-5-5' })],
    antigravity: [antigravity({ model: 'gemini-3.8-flash' })],
    // The image bakes Google's; each other provider's key, Bedrock's region and Vertex AI's
    // service account are other variables.
    opencode: [
      opencode({ model: 'google/gemini-3.8-flash' }),
      opencode({ model: 'anthropic/claude-haiku-4-5' }),
      opencode({ model: 'openai/gpt-5.5' }),
      opencode({ model: 'xai/grok-4.6' }),
      opencode({ model: 'amazon-bedrock/anthropic.claude-haiku-4-5' }),
      { ...opencode({ model: 'google/gemini-3.8-flash' }), gateway: 'vercel' },
      { ...opencode({ model: 'anthropic/claude-haiku-4-5' }), gateway: 'openrouter' },
      { ...opencode({ model: 'google/gemini-3.8-flash' }), gateway: 'vertex' },
    ],
    goose: [goose({ model: 'gemini-3.8-flash' })],
    pi: [pi({ model: 'gemini-3.8-flash' })],
    codex: [codex({ model: 'gpt-5.5' })],
    fx: [fx({ model: 'openai/gpt-5.5' })],
    'grok-build': [grokBuild({ model: 'grok-4.6' })],
  }
  const VERTEX = { project: 'p', location: 'global', regions: {} }
  const bootstrapOf = async (descriptor: AgentHarnessDescriptor) => {
    const agent = agentFor(descriptor, VERTEX)
    const adapter = await agent.adapter({
      auth: agentAuth(agent, { [agent.credential]: 'k' }),
      ...(agent.routeEnv ? { env: agent.routeEnv } : {}),
      ...(agent.adc
        ? { vertex: { project: 'p', location: 'global', credentialsFile: '/reeval/adc.json' } }
        : {}),
      descriptor,
      model: agent.modelId?.(descriptor.model) ?? descriptor.model,
      plugins: [],
    })
    return (adapter as HarnessV1).getBootstrap?.({})
  }
  // `unchecked` is Cursor without its model catalog, whose models take an effort.
  const takesEffort = (h: AgentHarnessDescriptor) =>
    [undefined, 'unchecked'].includes(noDefaultEffort(h))

  for (const harness of BAKED_HARNESSES) {
    test(`${harness}, at no effort, the default effort and its own`, async () => {
      const baked = await ((await bakedAdapter(harness)) as HarnessV1).getBootstrap?.({})
      for (const unset of ATTEMPTS[harness]) {
        const efforts = [unset, withDefaultEffort(unset)]
        if (takesEffort(unset)) efforts.push({ ...unset, effort: 'high' })
        for (const descriptor of efforts) {
          const id = `${harnessId(descriptor)} on ${descriptor.gateway ?? 'direct'} at ${harnessEffort(descriptor) ?? 'no effort'}`
          assert.deepEqual(await bootstrapOf(descriptor), baked, id)
        }
      }
    })
  }
})
