import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  CURSOR_SDK_BUILTIN_TOOLS,
  CURSOR_SDK_RUNNER,
  CURSOR_SDK_VERSION,
  catalogFor,
  createCursorSdkRequestTransformations,
  cursorSdkEndpoints,
  cursorSdkInstallScript,
  fetchCursorModelCatalog,
  getCursorSdkBootstrap,
  projectToolCall,
  projectToolResult,
  resolveCursorSdkCredentials,
  storedShapeProblems,
  storedWebCalls,
  VERSION,
} from '../src/index.ts'
import { fixture } from './support.ts'

describe('auth', () => {
  test("'auto' uses only CURSOR_API_KEY from the host", () => {
    assert.deepEqual(
      resolveCursorSdkCredentials('auto', { CURSOR_API_KEY: 'ck', AI_GATEWAY_API_KEY: 'gw' }),
      { apiKey: 'ck' },
    )
    assert.throws(() => resolveCursorSdkCredentials('auto', {}), /CURSOR_API_KEY isn't set/)
    assert.throws(() => resolveCursorSdkCredentials('nope' as never), /must be 'auto'/)
  })

  test('the key is swapped in on the key exchange only', () => {
    const [rule, ...rest] = createCursorSdkRequestTransformations({
      credentials: { apiKey: 'real' },
      placeholder: 'ph',
    })
    assert.equal(rest.length, 0)
    assert.deepEqual(rule?.match, {
      host: 'api2.cursor.sh',
      path: { exact: '/auth/exchange_user_api_key' },
      method: ['POST'],
      headers: [{ key: { exact: 'Authorization' }, value: { exact: 'Bearer ph' } }],
    })
    assert.deepEqual(rule?.transform, { headers: { Authorization: 'Bearer real' } })
    assert.deepEqual(cursorSdkEndpoints(), [
      { host: 'api2.cursor.sh', path: { exact: '/auth/exchange_user_api_key' }, method: ['POST'] },
    ])
  })

  test('the model catalog is fetched once on the host, and narrowed to the model', async () => {
    let calls = 0
    const fake = (async (url: string, init: RequestInit) => {
      calls++
      assert.equal(url, 'https://api.cursor.com/v1/models')
      assert.deepEqual(init.headers, { Authorization: 'Bearer k1' })
      return Response.json({
        items: [{ id: 'composer-2.5', aliases: ['composer'] }, { id: 'gpt-5.2' }],
      })
    }) as unknown as typeof fetch
    const a = await fetchCursorModelCatalog({ apiKey: 'k1' }, { fetch: fake })
    await fetchCursorModelCatalog({ apiKey: 'k1' }, { fetch: fake })
    assert.equal(calls, 1)
    assert.deepEqual(
      catalogFor(a, 'composer').map((m) => m.id),
      ['composer-2.5'],
    )
    assert.equal(catalogFor(a, 'unknown').length, 2, 'the SDK names the problem for an unknown id')
  })
})

describe('bootstrap', () => {
  test('installs the pinned SDK next to the runner, after checking Node', async () => {
    const bootstrap = await getCursorSdkBootstrap()
    assert.equal(bootstrap.bootstrapDir, '.harness-bootstrap/cursor-sdk')
    assert.deepEqual(
      bootstrap.files.map((f) => f.path),
      ['.harness-bootstrap/cursor-sdk/install.sh', '.harness-bootstrap/cursor-sdk/runner.mjs'],
    )
    const script = cursorSdkInstallScript()
    assert.match(script, new RegExp(`"@cursor/sdk": "${CURSOR_SDK_VERSION.replace(/\./g, '\\.')}"`))
    assert.match(script, /needs Node 22\.21\.0 or later/)
  })

  test('the runner forces HTTP/1.1 (HTTP/2 ignores the proxy) and keeps stdout for NDJSON', () => {
    assert.match(CURSOR_SDK_RUNNER, /useHttp1ForAgent: true/)
    assert.match(CURSOR_SDK_RUNNER, /process\.stdout\.write = process\.stderr\.write/)
    assert.match(CURSOR_SDK_RUNNER, /new JsonlLocalAgentStore\(turn\.storeDir\)/)
  })

  test('the runner recovers web calls from the stored conversation, which it can parse', () => {
    assert.match(
      CURSOR_SDK_RUNNER,
      /Agent\.messages\.list\(agent\.agentId, \{ cwd: turn\.cwd, store \}\)/,
    )
    assert.match(CURSOR_SDK_RUNNER, /recovered: 'Agent\.messages\.list'/)
    assert.match(CURSOR_SDK_RUNNER, /const storedWebCalls = function storedWebCalls\(/)
    assert.match(CURSOR_SDK_RUNNER, /const storedShapeProblems = function storedShapeProblems\(/)
    assert.doesNotThrow(
      () => new Function(`return async () => {${CURSOR_SDK_RUNNER.replace(/^import .*$/gm, '')}}`),
    )
  })

  test('storedWebCalls: a live stored conversation (as JSON) has the fetch and the search', () => {
    const messages = JSON.parse(fixture('stored-messages.json'))
    const calls = storedWebCalls(messages)
    assert.deepEqual(
      calls.map((c) => [c.name, c.call.args?.url ?? c.call.args?.searchTerm]),
      [
        ['webFetch', 'https://httpbin.org/ip'],
        ['webSearch', 'RFC 2606'],
      ],
    )
    for (const c of calls) {
      assert.match(c.id, /^tool_/)
      assert.ok(Number(c.at.completedAtMs) > Number(c.at.startedAtMs), 'the backend times it')
      assert.ok(c.call.result?.success, 'with its result')
    }
  })
})

describe('the stored conversation shape the runner reads (a contract on Agent.messages.list)', () => {
  const live = () => JSON.parse(fixture('stored-messages.json'))
  const problems = (messages: unknown) => storedShapeProblems(messages, storedWebCalls(messages))

  test('the live conversation from SDK 1.0.32 has every field the runner reads', () => {
    assert.equal(storedWebCalls(live()).length, 2)
    assert.deepEqual(problems(live()), [])
  })

  test('twins: each field it reads, gone or renamed, is named in the problem', () => {
    const mutate = (from: string, to: string) =>
      JSON.parse(JSON.stringify(live()).replaceAll(from, to))
    const fetchId = storedWebCalls(live())[0]?.id
    const cases: Array<[string, string, RegExp]> = [
      ['"startedAtMs"', '"startedAt"', new RegExp(`webFetch ${fetchId}: no startedAtMs`)],
      ['"completedAtMs"', '"endedAtMs"', /: no completedAtMs/],
      [
        '"url":"https://httpbin.org/ip"',
        '"href":"https://httpbin.org/ip"',
        /webFetch .*: args has no url/,
      ],
      ['"searchTerm"', '"query"', /webSearch .*: args has no searchTerm/],
      ['"success"', '"ok"', /result has neither success nor error/],
      [
        '"webFetchToolCall"',
        '"webFetchV2ToolCall"',
        /^an unknown web tool call key webFetchV2ToolCall$/,
      ],
    ]
    for (const [from, to, message] of cases) {
      const found = problems(mutate(from, to))
      assert.ok(
        found.some((p) => message.test(p)),
        `${from} → ${to}: ${JSON.stringify(found)}`,
      )
    }
  })
})

describe('tools', () => {
  test('SDK names map to the ACP adapter keys', () => {
    assert.equal(projectToolCall('shell', { command: 'ls' }).toolName, 'bash')
    assert.deepEqual(projectToolCall('glob', { globPattern: '*.ts' }).input, {
      globPattern: '*.ts',
      pattern: '*.ts',
    })
    for (const name of ['read', 'edit', 'delete', 'grep', 'ls', 'mcp', 'task']) {
      assert.equal(projectToolCall(name, {}).dynamic, false, name)
    }
    assert.ok('bash' in CURSOR_SDK_BUILTIN_TOOLS)
  })

  test('results: success values, shell text, errors', () => {
    assert.deepEqual(
      projectToolResult('bash', 'completed', {
        status: 'success',
        value: { stdout: 'a\n', stderr: 'b', exitCode: 1 },
      }),
      { output: 'a\nb' },
    )
    assert.deepEqual(
      projectToolResult('read', 'completed', { status: 'success', value: { content: 'x' } }),
      { output: { content: 'x' } },
    )
    assert.deepEqual(projectToolResult('edit', 'error', { status: 'error', error: 'nope' }), {
      output: 'nope',
      error: 'nope',
    })
  })
})

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})
