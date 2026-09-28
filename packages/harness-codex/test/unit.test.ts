import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  CODEX_CLI_INTEGRITY,
  CODEX_CLI_VERSION,
  CODEX_INSTALL_COMMAND,
  getCodexBootstrap,
} from '../src/codex-bootstrap.ts'
import {
  buildCodexCommand,
  buildCodexConfig,
  CODEX_CREDENTIAL_ENV,
  createCodex,
} from '../src/codex-harness.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test("the bootstrap installs the pinned Codex build for the sandbox's arch, checked against npm's sha512", async () => {
  const b = await getCodexBootstrap()
  assert.deepEqual(b.commands, [{ command: CODEX_INSTALL_COMMAND }])
  for (const arch of ['x64', 'arm64'] as const) {
    assert.ok(CODEX_INSTALL_COMMAND.includes(`sri=${CODEX_CLI_INTEGRITY[arch]}`), arch)
    assert.match(CODEX_CLI_INTEGRITY[arch], /^sha512-[A-Za-z0-9+/]{86}==$/)
  }
  assert.ok(
    CODEX_INSTALL_COMMAND.includes(
      `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-$arch.tgz`,
    ),
  )
  assert.match(CODEX_INSTALL_COMMAND, /does not match its sha512/)
})

test('the first turn starts a thread; later ones resume it, the prompt from its file', () => {
  const base = {
    binDir: '/h/bin',
    workDir: '/reeval/workspace',
    promptFile: '/d/prompt-1.txt',
    model: 'gpt-5.4-mini',
  }
  assert.equal(
    buildCodexCommand({ ...base, threadId: undefined }),
    `cd '/reeval/workspace' && PATH='/h/bin':"$PATH" exec codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --model 'gpt-5.4-mini' -- "$(cat '/d/prompt-1.txt')" < /dev/null`,
  )
  assert.equal(
    buildCodexCommand({ ...base, threadId: 't-1' }),
    `cd '/reeval/workspace' && PATH='/h/bin':"$PATH" exec codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --model 'gpt-5.4-mini' resume 't-1' -- "$(cat '/d/prompt-1.txt')" < /dev/null`,
  )
})

test("the config turns off analytics and plugins, and uses reeval's HTTP provider on the key", () => {
  const config = buildCodexConfig({})
  assert.equal(
    config,
    [
      '"check_for_update_on_startup" = false',
      '"analytics" = { "enabled" = false }',
      '"features" = { "plugins" = false }',
      '"model_provider" = "openai-http"',
      '"model_providers" = { "openai-http" = { "name" = "OpenAI", "base_url" = "https://api.openai.com/v1", "env_key" = "OPENAI_API_KEY", "wire_api" = "responses", "supports_websockets" = false } }',
      '',
    ].join('\n'),
  )
})

test('MCP servers are inline tables under mcp_servers, their strings JSON-quoted', () => {
  const config = buildCodexConfig({
    mcpServers: {
      stamp: { command: 'node', args: ['s "q".mjs'], env: { A: 'b\nc' } },
      web: { url: 'https://x.test/mcp', http_headers: { Authorization: 'Bearer t' } },
    },
  })
  assert.ok(
    config.includes(
      '"mcp_servers" = { "stamp" = { "command" = "node", "args" = ["s \\"q\\".mjs"], "env" = { "A" = "b\\nc" } }, "web" = { "url" = "https://x.test/mcp", "http_headers" = { "Authorization" = "Bearer t" } } }\n',
    ),
    config,
  )
  assert.doesNotMatch(buildCodexConfig({ mcpServers: {} }), /mcp_servers/)
})

test('auth is an environment with the OpenAI key, or it throws', () => {
  assert.throws(
    () => createCodex({ auth: {} }),
    /Codex auth must be an environment object with OPENAI_API_KEY/,
  )
  assert.equal(createCodex({ auth: { [CODEX_CREDENTIAL_ENV]: 'sk-k' } }).harnessId, 'codex')
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createCodex({
    auth: { [CODEX_CREDENTIAL_ENV]: 'sk-k' },
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker OPENAI_API_KEY .* so the key stays out of it/,
  )
})

test('a sandbox that brokers gets a placeholder, swapped for the key on the OpenAI API only', async () => {
  const rules: Array<{
    match: Record<string, unknown>
    transform: { headers: Record<string, string> }
  }> = []
  const writes: Array<{ path: string; content: string }> = []
  const harness = createCodex({ auth: { [CODEX_CREDENTIAL_ENV]: 'sk-real' } })
  const session = await harness.doStart({
    sessionId: 's1',
    sessionWorkDir: '/reeval/workspace',
    sandboxSession: {
      addRequestTransformations: async (r: typeof rules) => void rules.push(...r),
      run: async () => ({ exitCode: 0, stdout: '/home/reeval', stderr: '' }),
      writeTextFile: async (w: { path: string; content: string }) => void writes.push(w),
    },
  } as never)
  assert.equal(session.sessionId, 's1')
  assert.equal(rules.length, 1)
  const [rule] = rules
  assert.equal(rule?.match.host, 'api.openai.com')
  assert.equal(rule?.transform.headers.Authorization, 'Bearer sk-real')
  const placeholder = JSON.stringify(rule?.match.headers)
  assert.doesNotMatch(placeholder, /sk-real/)
  assert.deepEqual(
    writes.map((w) => w.path),
    ['/home/reeval/.codex/config.toml'],
  )
  assert.doesNotMatch(writes[0]?.content ?? '', /sk-real/)
})
