import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
  storedResults,
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

  // Its content is the marker a baked image carries: the image build and the run load different
  // builds of this module, and a mismatch reruns the install at every start.
  const dist = new URL('../dist/index.js', import.meta.url)
  test('is the same whichever build loads it (the source, or the compiled dist)', {
    skip: existsSync(dist) ? false : 'needs pnpm build',
  }, async () => {
    const compiled = (await import(dist.href)) as { getCursorSdkBootstrap: () => unknown }
    assert.deepEqual(await compiled.getCursorSdkBootstrap(), await getCursorSdkBootstrap())
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
    assert.match(CURSOR_SDK_RUNNER, /^function storedWebCalls\(/m)
    assert.match(CURSOR_SDK_RUNNER, /^function storedShapeProblems\(/m)
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

  test('the runner looks up the calls the stream left running in the stored conversation', () => {
    assert.match(CURSOR_SDK_RUNNER, /^function storedResults\(/m)
    assert.match(CURSOR_SDK_RUNNER, /storedResults\(messages, unfinished\)/)
  })
})

describe('storedResults: the results of calls the stream never completed', () => {
  // A live SDK 1.0.40 turn (read, glob, two edits, delete), its paths moved to the sandbox's.
  const live = () => JSON.parse(fixture('stored-tool-results.json'))
  const ids = {
    read: 'tool_54fbe467-b16f-434a-8eff-6421203147d',
    glob: 'tool_81dfede3-fe89-44b8-b9d4-3554a96d637',
    edit: 'tool_932f60e0-6025-4f01-9a55-84d824abedc',
    delete: 'tool_13d1bd82-2661-4419-8386-231fbc0dccc',
  }

  test('finds any tool by its call id, with the backend times and the result the stream sends', () => {
    const found = storedResults(live(), new Set([ids.read, ids.edit, ids.delete]))
    assert.deepEqual(found.map((c) => c.id).sort(), [ids.read, ids.edit, ids.delete].sort())
    const byId = new Map(found.map((c) => [c.id, c]))
    const read = byId.get(ids.read)
    assert.ok(read?.result.status === 'success')
    assert.equal(read.result.value.content, 'alpha\nbeta\ngamma\n')
    assert.ok(Number(read.at.completedAtMs) >= Number(read.at.startedAtMs))
    // What the stream sends for an edit, and none of the file contents the store adds.
    const edit = byId.get(ids.edit)
    assert.ok(edit?.result.status === 'success')
    assert.equal(edit.result.value.linesAdded, 1)
    assert.match(
      String(edit.result.value.diffString),
      /^--- \/dev\/null\n\+\+\+ b\/\/reeval\/workspace\/c\.txt/,
    )
    assert.equal(edit.result.value.beforeFullFileContent, undefined)
    assert.equal(edit.result.value.afterFullFileContent, undefined)
    const del = byId.get(ids.delete)
    assert.ok(del?.result.status === 'success')
    assert.equal(del.result.value.prevContent, undefined)
  })

  test('only the ids asked for, and a call with no result yet is not found', () => {
    assert.deepEqual(
      storedResults(live(), new Set([ids.glob])).map((c) => c.id),
      [ids.glob],
    )
    const pending = JSON.parse(JSON.stringify(live()), (key, value) =>
      key === 'readToolCall' ? { args: value.args } : value,
    )
    assert.deepEqual(storedResults(pending, new Set([ids.read])), [])
    assert.deepEqual(storedResults(live(), new Set(['tool_unknown'])), [])
  })

  const stored = (tool: string, result: unknown) =>
    storedResults({ toolCall: { [tool]: { args: {}, result }, toolCallId: 't1' } }, new Set(['t1']))
      .map((c) => c.result)
      .at(0)

  test('a failure is an error with its message, whichever oneof case the store uses', () => {
    assert.deepEqual(stored('readToolCall', { error: { error: 'ENOENT', path: '/a' } }), {
      status: 'error',
      error: { message: 'ENOENT' },
    })
    assert.deepEqual(stored('shellToolCall', { isBackground: false, rejected: { reason: 'no' } }), {
      status: 'error',
      error: { message: 'no' },
    })
    assert.deepEqual(stored('editToolCall', { fileNotFound: { path: '/a' } }), {
      status: 'error',
      error: { message: 'fileNotFound' },
    })
    assert.deepEqual(
      projectToolResult('read', 'error', { status: 'error', error: { message: 'ENOENT' } }),
      {
        output: 'ENOENT',
        error: 'ENOENT',
      },
    )
  })

  test("a command that exited non-zero is a success with its exit code, as the SDK's stream reports it", () => {
    const failure = {
      command: 'false',
      exitCode: 56,
      signal: '',
      stdout: '',
      stderr: 'curl: (56) CONNECT tunnel failed, response 403\n',
      executionTime: 597,
      interleavedOutput: 'curl: (56) CONNECT tunnel failed, response 403\n',
    }
    const recovered = stored('shellToolCall', { failure })
    assert.ok(recovered?.status === 'success')
    assert.equal(recovered.value.exitCode, 56)
    assert.equal(recovered.value.interleavedOutput, undefined)
    // The real egress capture's streamed result for this command.
    const streamed = {
      status: 'success',
      value: { exitCode: 56, signal: '', stdout: '', stderr: failure.stderr, executionTime: 597 },
    }
    assert.deepEqual(
      projectToolResult('bash', 'completed', recovered),
      projectToolResult('bash', 'completed', streamed),
    )
    assert.deepEqual(stored('shellToolCall', { timeout: { timeoutMs: 1000 } }), {
      status: 'error',
      error: { message: 'timeout' },
    })
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
