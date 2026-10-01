// `reeval mcp`: the official MCP client talks to the real CLI over stdio (in the 2026-07-28 stateless
// protocol and the 2025 handshake) and over stateless HTTP, against a project with recorded fake
// runs. Every tool's answer is checked against the CLI command it mirrors.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { killTree } from '@reeval/sandbox-docker/process'
import { VIEW_NAMES } from '../src/history/db.ts'
import { firstKeyword, sqlProblem } from '../src/mcp/server.ts'
import { baseEnv, pkgRoot, project, runCli } from './helpers.ts'

const cli = join(pkgRoot, 'dist/cli.js')
const MODERN = { pin: '2026-07-28' }
/** A value a secret-named variable holds; the eval's name carries it into every record. */
const PLANTED = 'zq8Kf93nd0w2LmXp4vT7'

type Json = Record<string, unknown>
type Tool = { structuredContent?: unknown; content: unknown; isError?: boolean }

const config = `
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness({ files: process.env.BREAK ? {} : { 'ok.txt': 'y' } }),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: {
    model: fakeAnalysis({
      output: () => ({
        tldr: 'Both evals pass.', whatHappened: [], results: [], why: [], anomalies: [],
        actions: [], confidence: { overall: 'high', why: 'one run' },
      }),
    }),
  },
})
`

const evals = {
  'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('writes ok', async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
  'evals/b.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('also writes ok ${PLANTED}', async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
}

async function connect(dir: string, mode: unknown, env: NodeJS.ProcessEnv = {}) {
  const client = new Client(
    { name: 'reeval-test', version: '1.0.0' },
    { versionNegotiation: { mode: mode as 'legacy' } },
  )
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp'],
      cwd: dir,
      env: { ...baseEnv, ...env } as Record<string, string>,
      stderr: 'pipe',
    }),
  )
  return client
}

const textOf = (r: Tool) => (r.content as Array<{ text: string }>)[0]?.text ?? ''

const call = async (client: Client, name: string, args: Json = {}) =>
  (await client.callTool({ name, arguments: args })) as Tool

async function json(client: Client, name: string, args: Json = {}): Promise<Json> {
  const r = await call(client, name, args)
  assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`)
  const text = (r.content as Array<{ text: string }>)[0]?.text ?? ''
  assert.deepEqual(JSON.parse(text), r.structuredContent, 'the text is the structured content')
  return r.structuredContent as Json
}

async function cliJson(dir: string, args: string[]) {
  const r = await runCli(dir, [...args, '--json'])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('reeval mcp', () => {
  let dir = ''
  let runs: string[] = []
  let modern: Client
  let legacy: Client

  before(async () => {
    const p = await project('mcp', { 'reeval.config.ts': config, ...evals })
    dir = p.dir
    assert.equal((await runCli(dir, ['run', '--record'])).code, 0)
    const second = await runCli(dir, ['run', '--record'], { env: { BREAK: '1' } })
    assert.equal(second.code, 1, 'the second run fails both evals')
    const saved = await runCli(dir, ['analyze', '--save'])
    assert.equal(saved.code, 0, saved.stderr)
    runs = (await cliJson(dir, ['history'])).runs.map((r: { runId: string }) => r.runId)
    assert.equal(runs.length, 2)
    modern = await connect(dir, MODERN)
    legacy = await connect(dir, 'legacy')
  })

  after(async () => {
    await modern?.close()
    await legacy?.close()
  })

  test('speaks the stateless 2026-07-28 protocol and the 2025 handshake, with one tool list', async () => {
    const discovered = modern.getDiscoverResult() as Json | undefined
    assert.ok(discovered, 'the pinned client discovered a modern server')
    assert.ok((discovered.supportedVersions as string[]).includes('2026-07-28'))
    assert.equal(legacy.getDiscoverResult(), undefined, 'the default client used initialize')
    assert.equal(modern.getServerVersion()?.name, 'reeval')
    assert.match(modern.getInstructions() ?? '', /Read-only access/)
    const names = (await modern.listTools()).tools.map((t) => t.name)
    assert.deepEqual(names, [
      'history',
      'show',
      'compare',
      'analysis',
      'transcript',
      ...VIEW_NAMES.map((v) => `query_${v}`),
      'query',
      'query_schema',
    ])
    assert.deepEqual(
      (await legacy.listTools()).tools.map((t) => t.name),
      names,
    )
    for (const tool of (await modern.listTools()).tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is read-only`)
    }
  })

  test("each query_<view> tool answers what reeval query <view> does, with its columns' filters", async () => {
    const schema = (await cliJson(dir, ['query', '--schema'])) as Array<Json>
    const tools = (await modern.listTools()).tools
    for (const view of VIEW_NAMES) {
      const expected = await cliJson(dir, ['query', view])
      const got = await json(modern, `query_${view}`, { limit: 1000 })
      assert.deepEqual(got.rows, expected, view)
      assert.equal(got.truncated, false)
      const columns = schema.find((o) => o.name === view)?.columns as string[]
      assert.deepEqual(got.columns, columns, `${view}: the columns of reeval query --schema`)
      const where = tools.find((t) => t.name === `query_${view}`)?.inputSchema.properties
        ?.where as { properties: Json }
      assert.deepEqual(Object.keys(where.properties), columns, `${view}: filterable by its columns`)
    }
    const failed = await json(modern, 'query_eval_trend', { where: { outcome: 'fail' } })
    assert.deepEqual(
      (failed.rows as Json[]).map((r) => [r.run_id, r.outcome]),
      [
        [runs[1], 'fail'],
        [runs[1], 'fail'],
      ],
    )
    const one = await json(modern, 'query_eval_trend', { limit: 1 })
    assert.equal((one.rows as Json[]).length, 1)
    assert.equal(one.truncated, true)
    const bad = await call(modern, 'query_eval_trend', { where: { nope: 1 } })
    assert.ok(bad.isError, 'an unknown column is refused')
  })

  test('query runs one read-only SELECT; query_schema is reeval query --schema', async () => {
    const r = await json(modern, 'query', {
      sql: '-- count\nSELECT COUNT(*) AS n FROM runs',
    })
    assert.deepEqual(r.rows, [{ n: 2 }])
    assert.deepEqual(
      (await json(modern, 'query_schema')).objects,
      await cliJson(dir, ['query', '--schema']),
    )
    for (const [sql, why] of [
      ['DELETE FROM runs', /Only SELECT and WITH/],
      ["ATTACH DATABASE '/etc/hosts' AS x", /Only SELECT and WITH/],
      ["VACUUM INTO '/tmp/copy.db'", /Only SELECT and WITH/],
      ['PRAGMA table_info(runs)', /Only SELECT and WITH/],
      ['SELECT 1; DROP TABLE runs', /exactly one SQL statement/],
      ['WITH x AS (SELECT 1) DELETE FROM runs', /read-only/],
      ['SELECT * FROM nope', /no such table/],
    ] as const) {
      const bad = await call(modern, 'query', { sql })
      assert.ok(bad.isError, sql)
      assert.match(textOf(bad), why, sql)
    }
    assert.equal(
      await json(modern, 'query', { sql: 'SELECT COUNT(*) AS n FROM runs' }).then(
        (x) => (x.rows as Json[])[0]?.n,
      ),
      2,
      'nothing was deleted',
    )
    assert.equal(firstKeyword('  /* a */ -- b\n with x'), 'WITH')
    assert.equal(sqlProblem('select 1;'), null)
  })

  test('show, compare and history answer what their --json does', async () => {
    assert.deepEqual(await json(modern, 'show'), await cliJson(dir, ['show']))
    assert.deepEqual(
      await json(legacy, 'show', { run: runs[0] }),
      await cliJson(dir, ['show', runs[0] as string]),
    )
    const md = await json(modern, 'show', { format: 'md' })
    assert.equal(md.markdown, (await runCli(dir, ['show', '--md'])).stdout.trimEnd())
    assert.deepEqual(await json(modern, 'compare'), await cliJson(dir, ['compare']))
    const both = await json(modern, 'compare', { base: runs[0], head: runs[1] })
    assert.deepEqual(both, await cliJson(dir, ['compare', runs[0] as string, runs[1] as string]))
    assert.deepEqual(await json(modern, 'history'), await cliJson(dir, ['history']))
    assert.deepEqual(
      await json(modern, 'history', { filter: 'also', limit: 1 }),
      await cliJson(dir, ['history', 'also', '--limit', '1']),
    )
    const missing = await call(modern, 'show', { run: 'nope' })
    assert.ok(missing.isError)
    assert.match(textOf(missing), /No run matches "nope"/)
  })

  test('analysis returns the saved analysis without calling a model', async () => {
    const r = await json(modern, 'analysis', { run: runs[1] })
    const entries = r.entries as Array<{
      source: string
      doc: { anchor: string; analysis: { tldr: string } }
    }>
    assert.equal(r.runId, runs[1])
    assert.ok(entries.some((e) => e.source === 'saved'))
    assert.equal(entries[0]?.doc.anchor, runs[1])
    assert.equal(entries[0]?.doc.analysis.tldr, 'Both evals pass.')
    assert.deepEqual((await json(modern, 'analysis', { run: runs[0] })).entries, [])
  })

  test('transcripts, as a tool and as resources; runs are resources', async () => {
    const record = await cliJson(dir, ['show'])
    const attempt = record.evals[0].attempts[0]
    const r = await json(modern, 'transcript', { attempt: attempt.key })
    assert.equal(r.attempt, attempt.key)
    const lines = r.lines as Json[]
    assert.equal(r.total, lines.length)
    assert.ok(lines.some((l) => l.type === 'prompt' && l.text === 'go'))
    const page = await json(modern, 'transcript', { attempt: attempt.key, offset: 1, limit: 1 })
    assert.deepEqual(page.lines, lines.slice(1, 2))

    const read = await modern.readResource({ uri: r.uri as string })
    const text = (read.contents[0] as { text: string }).text
    assert.deepEqual(
      text.split('\n').map((l) => JSON.parse(l)),
      lines,
      'the resource holds the same lines',
    )

    const listed = (await modern.listResources()).resources.map((x) => x.uri)
    assert.deepEqual(
      listed,
      [...runs].reverse().map((id) => `reeval://runs/${id}`),
    )
    const run = await legacy.readResource({ uri: `reeval://runs/${runs[0]}` })
    assert.deepEqual(
      JSON.parse((run.contents[0] as { text: string }).text),
      await cliJson(dir, ['show', runs[0] as string]),
    )

    const ambiguous = await call(modern, 'transcript', { attempt: attempt.id })
    assert.ok(ambiguous.isError, 'two evals share the attempt id')
    assert.match(textOf(ambiguous), /use its key/)
    for (const bad of [
      `reeval://runs/${runs[0]}/transcripts/..%2F..%2Freeval.config.ts`,
      'reeval://runs/..%2F..',
    ]) {
      await assert.rejects(modern.readResource({ uri: bad }), bad)
    }
  })

  test('masks secret-looking values from its environment in everything it returns', async () => {
    const client = await connect(dir, MODERN, { REEVAL_TEST_API_KEY: PLANTED })
    try {
      const shown = JSON.stringify(await json(client, 'show'))
      assert.ok(!shown.includes(PLANTED))
      assert.match(shown, /also writes ok \[REDACTED\]/)
      const rows = JSON.stringify(await json(client, 'query_eval_trend'))
      assert.ok(!rows.includes(PLANTED))
      const run = await client.readResource({ uri: `reeval://runs/${runs[0]}` })
      assert.ok(!JSON.stringify(run).includes(PLANTED))
    } finally {
      await client.close()
    }
    assert.ok(JSON.stringify(await json(modern, 'show')).includes(PLANTED), 'unmasked without it')
  })

  /** Starts `reeval mcp --http` on a free port; resolves once it's listening. */
  async function serveHttp(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
    const port = await freePort()
    const child: ChildProcess = spawn(
      process.execPath,
      [cli, 'mcp', '--http', '--port', String(port), ...args],
      { cwd: dir, env: { ...baseEnv, ...env }, detached: process.platform !== 'win32' },
    )
    let out = ''
    await new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => reject(new Error(`reeval mcp --http exited ${code}`)))
      child.stdout?.on('data', (d) => {
        out += d
        if (out.includes('Ctrl-C')) resolve()
      })
    })
    const url = `http://127.0.0.1:${port}/mcp`
    assert.ok(out.includes(url), out)
    const raw = (headers: Record<string, string>, method = 'POST') =>
      new Promise<number>((resolve, reject) => {
        const req = request(url, { method, headers }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end(method === 'POST' ? '{}' : undefined)
      })
    const stop = () => child.pid && killTree(child.pid)
    return { url, port, out, raw, stop }
  }

  async function httpClient(url: string, headers: Record<string, string> = {}) {
    const client = new Client(
      { name: 'reeval-test', version: '1.0.0' },
      { versionNegotiation: { mode: MODERN } },
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
    )
    return client
  }

  const JSON_POST = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }

  test('--http serves stateless Streamable HTTP with no token, behind Host and Origin checks', async () => {
    const http = await serveHttp()
    try {
      assert.doesNotMatch(http.out, /Bearer/, 'no token by default')
      const client = await httpClient(http.url)
      assert.ok(client.getDiscoverResult())
      assert.deepEqual(await json(client, 'show'), await cliJson(dir, ['show']))
      await client.close()
      assert.equal(
        await http.raw({ ...JSON_POST, host: `evil.example:${http.port}` }),
        403,
        'a foreign Host',
      )
      assert.equal(
        await http.raw({ ...JSON_POST, origin: 'http://evil.example' }),
        403,
        'a foreign Origin',
      )
      assert.equal(await http.raw(JSON_POST, 'GET'), 405, 'no GET stream in 2026-07-28')
    } finally {
      http.stop()
    }
  })

  test('--http with a token (--token beats REEVAL_MCP_TOKEN) wants it as a bearer token', async () => {
    const http = await serveHttp(['--token', 'flag-token-123'], {
      REEVAL_MCP_TOKEN: 'env-token-456',
    })
    try {
      assert.match(http.out, /requires Authorization: Bearer/)
      assert.ok(!http.out.includes('flag-token-123'), 'the token is never printed')
      assert.equal(await http.raw(JSON_POST), 401, 'no token')
      assert.equal(
        await http.raw({ ...JSON_POST, authorization: 'Bearer wrong' }),
        401,
        'a wrong one',
      )
      const env = { ...JSON_POST, authorization: 'Bearer env-token-456' }
      assert.equal(await http.raw(env), 401, 'the flag wins over REEVAL_MCP_TOKEN')
      const auth = { authorization: 'Bearer flag-token-123' }
      assert.equal(
        await http.raw({ ...JSON_POST, ...auth, host: `evil.example:${http.port}` }),
        403,
      )
      const client = await httpClient(http.url, auth)
      assert.deepEqual(await json(client, 'show'), await cliJson(dir, ['show']))
      await client.close()
    } finally {
      http.stop()
    }
    const fromEnv = await serveHttp([], { REEVAL_MCP_TOKEN: 'env-token-456' })
    try {
      assert.equal(await fromEnv.raw(JSON_POST), 401, 'REEVAL_MCP_TOKEN alone sets it')
      const client = await httpClient(fromEnv.url, { authorization: 'Bearer env-token-456' })
      assert.ok(client.getDiscoverResult())
      await client.close()
    } finally {
      fromEnv.stop()
    }
  })

  test('usage errors', async () => {
    const r = await runCli(dir, ['mcp', '--port', '1234'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--port needs --http/)
    const token = await runCli(dir, ['mcp', '--token', 'x'])
    assert.equal(token.code, 2)
    assert.match(token.stderr, /--token needs --http/)
    const bad = await runCli(dir, ['mcp', '--http', '--port', 'x'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--port must be a port number/)
  })
})
