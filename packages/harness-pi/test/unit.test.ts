import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { getPiBootstrap, PI_CLI_VERSION } from '../src/pi-bootstrap.ts'
import {
  buildPiCommand,
  buildPiMcpConfig,
  createPi,
  escapePiConfigValue,
  PI_CREDENTIAL_ENV,
  PI_MCP_FILE,
  type PiHarnessSettings,
  type PiMcpServer,
} from '../src/pi-harness.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the bootstrap installs the pinned pi from its lockfile, without build scripts', async () => {
  const b = await getPiBootstrap()
  const manifest = b.files?.find((f) => f.path.endsWith('/package.json'))
  const lock = b.files?.find((f) => f.path.endsWith('/pnpm-lock.yaml'))
  assert.deepEqual(JSON.parse(String(manifest?.content)).dependencies, {
    '@earendil-works/pi-coding-agent': PI_CLI_VERSION,
  })
  assert.match(
    String(lock?.content),
    new RegExp(`^  '@earendil-works/pi-coding-agent@${PI_CLI_VERSION}':$`, 'm'),
  )
  assert.deepEqual(b.commands, [
    { command: 'pnpm install --frozen-lockfile --prod --ignore-scripts' },
  ])
})

test('each turn runs pi in print mode on one session id, the prompt from its file', () => {
  const command = buildPiCommand({
    cli: '/h/pi',
    workDir: '/reeval/workspace',
    promptFile: '/d/prompt-1.txt',
    model: 'gemini-3.8-flash',
    sessionId: 'abc',
    sessionDir: '/h/.pi/agent/sessions',
  })
  assert.equal(
    command,
    `cd '/reeval/workspace' && exec '/h/pi' --mode json -p --offline --approve --no-extensions --provider google --model 'gemini-3.8-flash' --session-id 'abc' --session-dir '/h/.pi/agent/sessions' -- "$(cat '/d/prompt-1.txt')"`,
  )
})

test("with MCP servers, the turn loads pi's built-in mcp extension and no other", () => {
  const command = buildPiCommand({
    cli: '/h/pi',
    workDir: '/w',
    promptFile: '/d/p.txt',
    model: undefined,
    sessionId: 'abc',
    sessionDir: '/s',
    mcp: true,
  })
  assert.match(command, / --approve --no-extensions -e builtin:mcp --provider google /)
})

test('effort is --thinking', () => {
  const command = buildPiCommand({
    cli: '/h/pi',
    workDir: '/w',
    promptFile: '/d/p.txt',
    model: 'gemini-3.8-flash',
    sessionId: 'abc',
    sessionDir: '/s',
    thinking: 'high',
  })
  assert.match(command, / --model 'gemini-3\.8-flash' --thinking 'high' --session-id /)
})

test('env and header values are escaped so pi reads them literally', () => {
  assert.equal(escapePiConfigValue('plain'), 'plain')
  assert.equal(escapePiConfigValue('$HOME'), '$$HOME')
  // biome-ignore lint/suspicious/noTemplateCurlyInString: pi's own ${NAME} syntax
  assert.equal(escapePiConfigValue('a${B}c$$'), 'a$${B}c$$$$')
  assert.equal(escapePiConfigValue('!rm -rf /'), '$!rm -rf /')
  assert.equal(escapePiConfigValue('!echo $X'), '$!echo $$X')
  assert.equal(escapePiConfigValue('$!x'), '$$!x')
  assert.equal(escapePiConfigValue('not!first'), 'not!first')
})

test("each escaped value resolves, under pi's expansion rules, to the value as written", () => {
  // pi's rules (core/resolve-config-value.js): a leading `!` runs a command; otherwise
  // `$$` and `$!` are literals and `$NAME` or `${NAME}` expands.
  const resolve = (config: string) => {
    if (config.startsWith('!')) return { command: config.slice(1) }
    return config.replace(/\$(\$|!|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (m, r) =>
      r === '$' || r === '!' ? r : `<env ${m}>`,
    )
  }
  for (const value of [
    'plain',
    '$HOME',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pi's own ${NAME} syntax
    '${TOKEN}',
    'Bearer $X',
    '!id',
    '!a$b',
    '$!',
    '$$',
    'x!',
  ]) {
    assert.equal(resolve(escapePiConfigValue(value)), value)
  }
})

test('mcp.json declares every server directly, with literal env and headers, and no codemode', () => {
  const config = JSON.parse(
    buildPiMcpConfig({
      stamp: { command: 'node', args: ['stamp.mjs'], env: { TOKEN: '$SECRET', RUN: '!id' } },
      docs: { url: 'https://mcp.example.com/mcp', headers: { 'x-api-key': 'k$1' } },
      bare: { command: 'mcp' },
    }),
  )
  assert.deepEqual(config, {
    mcpServers: {
      stamp: {
        command: 'node',
        args: ['stamp.mjs'],
        env: { TOKEN: '$$SECRET', RUN: '$!id' },
        exposure: 'direct',
      },
      docs: {
        url: 'https://mcp.example.com/mcp',
        headers: { 'x-api-key': 'k$$1' },
        exposure: 'direct',
      },
      bare: { command: 'mcp', args: [], env: {}, exposure: 'direct' },
    },
    autoEnableCodemode: false,
  })
})

/** A sandbox that brokers and records what's written and spawned. */
function recordingSandbox(stdout: string[] = []) {
  const writes: Array<{ path: string; content: string }> = []
  const spawned: string[] = []
  const envs: Array<Record<string, string>> = []
  const stream = (lines: string[] = []) =>
    new ReadableStream<Uint8Array>({
      start: (c) => {
        for (const line of lines) c.enqueue(new TextEncoder().encode(`${line}\n`))
        c.close()
      },
    })
  const sandbox = {
    addRequestTransformations: async () => {},
    run: async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' }),
    readTextFile: async () => null,
    writeTextFile: async (o: { path: string; content: string }) => {
      writes.push({ path: o.path, content: o.content })
    },
    spawn: async (o: { command: string; env: Record<string, string> }) => {
      spawned.push(o.command)
      envs.push(o.env)
      return {
        stdout: stream(stdout),
        stderr: stream(),
        wait: async () => ({ exitCode: 0 }),
        kill: async () => {},
      }
    },
  }
  return { sandbox, writes, spawned, envs }
}

async function oneTurn(
  mcpServers?: Record<string, PiMcpServer>,
  stdout?: string[],
  settings: Partial<PiHarnessSettings> = { auth: { [PI_CREDENTIAL_ENV]: 'AIza-k' } },
) {
  const { sandbox, writes, spawned, envs } = recordingSandbox(stdout)
  const parts: HarnessV1StreamPart[] = []
  const harness = createPi({
    auth: {},
    ...settings,
    ...(mcpServers ? { mcpServers } : {}),
    requireCredentialBrokering: true,
  })
  const session = await harness.doStart({
    sandboxSession: sandbox,
    sessionWorkDir: '/w',
    sessionId: 's1',
  } as never)
  const control = await session.doPromptTurn({
    prompt: 'hi',
    tools: [],
    skills: [],
    emit: (part: HarnessV1StreamPart) => parts.push(part),
  } as never)
  await control.done
  return { writes, spawned, envs, parts }
}

test('a session with MCP servers writes mcp.json under the home and loads the mcp extension', async () => {
  const { writes, spawned } = await oneTurn({ stamp: { command: 'node', args: ['stamp.mjs'] } })
  const mcp = writes.find((w) => w.path.endsWith(`/${PI_MCP_FILE}`))
  assert.equal(mcp?.path, `/root/${PI_MCP_FILE}`)
  assert.equal(JSON.parse(String(mcp?.content)).mcpServers.stamp.exposure, 'direct')
  assert.match(spawned[0] ?? '', / --no-extensions -e builtin:mcp /)
})

test("a dashed server's tools are named with its configured name, not pi's mcp__my_docs__", async () => {
  const { parts } = await oneTurn({ 'my-docs': { command: 'node', args: ['docs.mjs'] } }, [
    JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'mcp__my_docs__latest_version', arguments: {} },
      },
    }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } }),
    JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'mcp__my_docs__latest_version',
      result: { content: [{ type: 'text', text: '4.2.0' }] },
    }),
    JSON.stringify({ type: 'agent_end' }),
  ])
  assert.deepEqual(
    parts.flatMap((p) => (p.type === 'tool-call' || p.type === 'tool-result' ? [p.toolName] : [])),
    ['mcp__my-docs__latest_version', 'mcp__my-docs__latest_version'],
  )
})

test('a session without MCP servers writes no mcp.json and loads no extension', async () => {
  const { writes, spawned } = await oneTurn()
  assert.equal(
    writes.some((w) => w.path.endsWith('mcp.json')),
    false,
  )
  assert.doesNotMatch(spawned[0] ?? '', /-e builtin:mcp/)
})

test('auth is an environment with the Gemini key, or it throws', () => {
  assert.throws(
    () => createPi({ auth: {} }),
    /pi auth must be an environment object with GEMINI_API_KEY/,
  )
  assert.equal(createPi({ auth: { [PI_CREDENTIAL_ENV]: 'AIza-k' } }).harnessId, 'pi')
})

test('on Vertex AI, pi runs its google-vertex provider on a credentials file, with no key', async () => {
  const vertex = { project: 'p', location: 'global', credentialsFile: '/reeval/adc.json' }
  const { spawned, envs } = await oneTurn(undefined, undefined, { auth: {}, vertex })
  assert.match(spawned[0] ?? '', / --provider google-vertex /)
  assert.deepEqual(envs[0], {
    GOOGLE_CLOUD_PROJECT: 'p',
    GOOGLE_CLOUD_LOCATION: 'global',
    GOOGLE_APPLICATION_CREDENTIALS: '/reeval/adc.json',
    PI_OFFLINE: '1',
  })
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createPi({
    auth: { [PI_CREDENTIAL_ENV]: 'AIza-k' },
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker GEMINI_API_KEY .* so the key stays out of it/,
  )
})
