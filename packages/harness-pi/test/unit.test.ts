import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { getPiBootstrap, PI_CLI_VERSION } from '../src/pi-bootstrap.ts'
import {
  buildPiCommand,
  buildPiMcpConfig,
  createPi,
  escapePiConfigValue,
  PI_CREDENTIAL_ENV,
  PI_MCP_FILE,
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
  // pi's rules (core/resolve-config-value.js, 0.99.1): a leading `!` runs a command; otherwise
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
function recordingSandbox() {
  const writes: Array<{ path: string; content: string }> = []
  const spawned: string[] = []
  const empty = () =>
    new ReadableStream<Uint8Array>({
      start: (c) => c.close(),
    })
  const sandbox = {
    addRequestTransformations: async () => {},
    run: async () => ({ exitCode: 0, stdout: '/root\n', stderr: '' }),
    readTextFile: async () => null,
    writeTextFile: async (o: { path: string; content: string }) => {
      writes.push({ path: o.path, content: o.content })
    },
    spawn: async (o: { command: string }) => {
      spawned.push(o.command)
      return {
        stdout: empty(),
        stderr: empty(),
        wait: async () => ({ exitCode: 0 }),
        kill: async () => {},
      }
    },
  }
  return { sandbox, writes, spawned }
}

async function oneTurn(mcpServers?: Record<string, PiMcpServer>) {
  const { sandbox, writes, spawned } = recordingSandbox()
  const harness = createPi({
    auth: { [PI_CREDENTIAL_ENV]: 'AIza-k' },
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
    emit: () => {},
  } as never)
  await control.done
  return { writes, spawned }
}

test('a session with MCP servers writes mcp.json under the home and loads the mcp extension', async () => {
  const { writes, spawned } = await oneTurn({ stamp: { command: 'node', args: ['stamp.mjs'] } })
  const mcp = writes.find((w) => w.path.endsWith(`/${PI_MCP_FILE}`))
  assert.equal(mcp?.path, `/root/${PI_MCP_FILE}`)
  assert.equal(JSON.parse(String(mcp?.content)).mcpServers.stamp.exposure, 'direct')
  assert.match(spawned[0] ?? '', / --no-extensions -e builtin:mcp /)
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
