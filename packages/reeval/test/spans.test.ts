// The run's trace, spans.jsonl: a fake run writes one with the run, its attempts and their phases
// under it, the record names it, recording keeps it with the run's evidence, and with
// OTEL_EXPORTER_OTLP_ENDPOINT set the run sends its spans, log records and metrics to a collector
// during the run.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { describe, test } from 'node:test'
import type { logsRequest, metricsRequest, tracesRequest } from '../src/trace/otlp.ts'
import { RunTrace, traceIdOf } from '../src/trace/run.ts'
import { parseSpans, type RunSpan } from '../src/view/spans.ts'
import { fakeConfig, project, readRun, runCli, tempDir } from './helpers.ts'

const evalFile = `import { evaluate, expect } from 'reeval'
evaluate('writes hello', async (c) => {
  await c.send('write hello.txt')
  expect(1).toBe(1)
})
`

const harness = `{ files: { 'hello.txt': 'hi\\n' }, text: 'done' }`

async function fakeProject(name: string) {
  const p = await project(name, {
    '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
    'reeval.config.ts': fakeConfig({ harness, extra: 'runs: 2,' }),
    'evals/a.eval.ts': evalFile,
  })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: p.dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A')
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
  return p
}

/** A collector on loopback that takes every request, keeping JSON bodies parsed. */
async function startCollector(t: TestContext) {
  const requests: Array<{ path: string; auth?: string; type?: string; body: unknown }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      const type = req.headers['content-type']
      const raw = Buffer.concat(chunks)
      requests.push({
        path: req.url ?? '',
        ...(req.headers.authorization && { auth: req.headers.authorization }),
        ...(type && { type }),
        body: type === 'application/json' ? JSON.parse(raw.toString('utf8')) : raw,
      })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    of: (path: string) => requests.filter((r) => r.path === path).map((r) => r.body),
  }
}

const byName = (spans: RunSpan[], name: string) => spans.filter((s) => s.name === name)

describe('run spans', () => {
  test('a run writes its spans, and recording keeps them', async () => {
    const p = await fakeProject('spans')
    const r = await runCli(p.dir, ['run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)

    const { run, read } = readRun(p.dir)
    assert.equal(run.spans?.path, 'spans.jsonl')
    const spans = parseSpans(read('spans.jsonl'))
    const [root, ...more] = byName(spans, 'reeval.run')
    assert.ok(root, 'one reeval.run span')
    assert.equal(more.length, 0)
    assert.equal(root.parentSpanId, undefined)
    assert.equal(root.attributes['reeval.run.id'], run.runId)
    for (const s of spans) assert.equal(s.traceId, traceIdOf(run.runId))

    const attempts = byName(spans, 'attempt')
    assert.deepEqual(
      attempts.map((a) => a.attributes['reeval.attempt.key']).sort(),
      run.evals.flatMap((e) => e.attempts.map((a) => a.key)).sort(),
    )
    for (const a of attempts) {
      assert.equal(a.parentSpanId, root.spanId)
      assert.equal(a.attributes['reeval.outcome'], 'pass')
      assert.ok(a.startMs <= a.endMs)
      const phases = spans.filter((s) => s.parentSpanId === a.spanId).map((s) => s.name)
      for (const phase of ['setup', 'sandbox', 'agent']) assert.ok(phases.includes(phase), phase)
    }

    const recording = await runCli(p.dir, ['record', run.runId])
    assert.equal(recording.code, 0, recording.stdout + recording.stderr)
    const recorded = readRun(p.dir, { history: 'evals/.history' })
    assert.deepEqual(recorded.run.spans, run.spans)
    assert.equal(recorded.read('spans.jsonl'), read('spans.jsonl'))
  })

  test('with OTEL_EXPORTER_OTLP_ENDPOINT set, the run sends spans, log records and metrics', async (t) => {
    const collector = await startCollector(t)
    const p = await fakeProject('spans-otlp')
    const r = await runCli(p.dir, ['run'], {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `${collector.url}/`,
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_SERVICE_NAME: 'evals',
      },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run, read } = readRun(p.dir)
    for (const sent of collector.requests) assert.equal(sent.auth, 'Bearer abc')
    const traces = collector.of('/v1/traces') as Array<ReturnType<typeof tracesRequest>>
    const [resource] = traces[0]?.resourceSpans ?? []
    assert.deepEqual(resource?.resource.attributes, [
      { key: 'service.name', value: { stringValue: 'evals' } },
    ])
    const sentSpans = traces.flatMap((b) => b.resourceSpans[0]?.scopeSpans[0]?.spans ?? [])
    const written = parseSpans(read('spans.jsonl'))
    assert.deepEqual(sentSpans.map((s) => s.spanId).sort(), written.map((s) => s.spanId).sort())
    assert.match(
      sentSpans.find((s) => s.name === 'reeval.run')?.startTimeUnixNano ?? '',
      /^\d{19}$/,
    )

    const logs = (collector.of('/v1/logs') as Array<ReturnType<typeof logsRequest>>).flatMap(
      (b) => b.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [],
    )
    const attempts = logs.filter((l) => l.body.stringValue.startsWith('passed writes hello'))
    assert.equal(attempts.length, 2, JSON.stringify(logs))
    for (const l of logs) assert.equal(l.traceId, traceIdOf(run.runId))

    const metrics = (
      collector.of('/v1/metrics') as Array<ReturnType<typeof metricsRequest>>
    ).flatMap((b) => b.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [])
    assert.ok(
      metrics.some((m) => m.name === 'system.cpu.utilization'),
      'one sample at the end',
    )
  })

  test('spans go out in batches as they end, not only when the run does', async (t) => {
    const collector = await startCollector(t)
    const p = await project('spans-otlp-live', {
      'reeval.config.ts': fakeConfig({ harness, extra: 'runs: 2, concurrency: 1,' }),
      'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('writes hello', async (c) => {
  await c.send('write hello.txt')
  await new Promise((r) => setTimeout(r, 1500))
  expect(1).toBe(1)
})
`,
    })
    const r = await runCli(p.dir, ['run'], {
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/v1/traces`,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_BSP_SCHEDULE_DELAY: '100',
      },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const batches = (collector.of('/v1/traces') as Array<ReturnType<typeof tracesRequest>>).map(
      (b) => (b.resourceSpans[0]?.scopeSpans[0]?.spans ?? []).map((s) => s.name),
    )
    assert.ok(batches.length >= 2, JSON.stringify(batches))
    const first = batches.findIndex((names) => names.includes('attempt'))
    const root = batches.findIndex((names) => names.includes('reeval.run'))
    assert.ok(first >= 0 && first < root, 'an attempt went out before the run ended')
  })

  test('protobuf is the default protocol', async (t) => {
    const collector = await startCollector(t)
    const p = await fakeProject('spans-otlp-proto')
    const r = await runCli(p.dir, ['run'], {
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/v1/traces` },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(collector.requests.length > 0)
    for (const sent of collector.requests) assert.equal(sent.type, 'application/x-protobuf')
  })

  test('a failed attempt is an error span with its outcome, and the run goes on', async () => {
    const p = await project('spans-fail', {
      'reeval.config.ts': fakeConfig({ harness }),
      'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('fails', async (c) => {
  await c.send('write hello.txt')
  expect(1).toBe(2)
})
evaluate('throws', async () => {
  throw new Error('boom ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}')
})
`,
    })
    const r = await runCli(p.dir, ['run'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const { run, read } = readRun(p.dir)
    const text = read('spans.jsonl')
    assert.doesNotMatch(text, /ghp_a1B2/, 'errors in the trace are redacted')
    const attempts = byName(parseSpans(text), 'attempt')
    const of = (name: string) => {
      const key = run.evals.find((e) => e.name === name)?.attempts[0]?.key
      return attempts.find((a) => a.attributes['reeval.attempt.key'] === key)
    }
    assert.equal(of('fails')?.attributes['reeval.outcome'], 'fail')
    assert.equal(of('throws')?.attributes['reeval.outcome'], 'fail')
    for (const a of [of('fails'), of('throws')]) {
      assert.ok(a && a.endMs >= a.startMs)
      assert.equal(a.status?.code, 'error')
    }
    assert.match(of('throws')?.status?.message ?? '', /^boom \[REDACTED\]/)
  })

  test("a collector that hangs never holds up the run's record", async (t) => {
    const p = await fakeProject('spans-otlp-slow')
    const runs = join(p.dir, '.reeval/runs')
    const recorded = () => existsSync(runs) && readdirSync(runs).some((f) => f.endsWith('.json'))
    let sawRecord = false
    const server = createServer(async (req, res) => {
      req.resume()
      for (let i = 0; i < 200 && !recorded(); i++) await new Promise((r) => setTimeout(r, 100))
      sawRecord = recorded()
      res.writeHead(200).end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const { port } = server.address() as AddressInfo
    const r = await runCli(p.dir, ['run'], {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_TIMEOUT: '120000',
      },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(sawRecord, 'the record was written while the export was still waiting')
  })

  test('a collector that refuses the spans is a warning, not a failed run', async () => {
    const p = await fakeProject('spans-otlp-down')
    const r = await runCli(p.dir, ['run'], {
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:1/v1/traces' },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout + r.stderr,
      /OpenTelemetry export: couldn't reach http:\/\/127\.0\.0\.1:1/,
    )
    assert.ok(readFileSync(join(readRun(p.dir).dir, 'spans.jsonl'), 'utf8').length > 0)
  })
})

describe('RunTrace', () => {
  test('hands each span to onSpan as it writes it, and redacts errors first', () => {
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`
    const dir = tempDir('run-trace')
    const handed: RunSpan[] = []
    const trace = new RunTrace({ dir, runId: 'r', onSpan: (s) => handed.push(s) })
    trace.add({
      spanId: '1'.padStart(16, '0'),
      name: 'attempt',
      startMs: 1,
      endMs: 2,
      attributes: {},
      status: { code: 'error', message: `start failed: ${token}` },
    })
    assert.equal(handed.length, 1, 'before the run ends')
    trace.close()
    assert.deepEqual(
      handed.map((s) => s.name),
      ['attempt', 'reeval.run'],
    )
    const text = readFileSync(join(dir, 'spans.jsonl'), 'utf8')
    assert.deepEqual(parseSpans(text), handed)
    assert.doesNotMatch(text + JSON.stringify(handed), /ghp_a1B2/)
  })
})
