// OpenTelemetry export without a run: which signals the standard variables turn on, the host
// metrics, and the SDK pipeline startTelemetry builds, against a collector on loopback: spans with
// their own ids, times and parents, the log records a run's events become, a refused export, and a
// close bounded however the collector behaves.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestContext } from 'node:test'
import { describe, test } from 'node:test'
import { HOST_METRICS, HostMetrics } from '../src/trace/host-metrics.ts'
import { otlpConfigured, otlpProtocol } from '../src/trace/otlp.ts'
import { CLOSE_MS, startTelemetry } from '../src/trace/telemetry.ts'
import type { RunSpan } from '../src/view/spans.ts'

const T = 'a'.repeat(32)
const S = 'b'.repeat(16)
const P = 'c'.repeat(16)
const L = 'd'.repeat(16)
const R = 'e'.repeat(16)

describe('OTLP signals', () => {
  test('nothing is configured without an endpoint, or with the SDK off', () => {
    assert.equal(otlpConfigured({}), false)
    assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://c' }), true)
    assert.equal(
      otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_SDK_DISABLED: 'true' }),
      false,
    )
    const on = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }
    assert.equal(otlpProtocol({}, 'traces'), null)
    assert.equal(otlpProtocol({ ...on, OTEL_SDK_DISABLED: 'true' }, 'traces'), null)
    assert.equal(otlpProtocol({ ...on, OTEL_SDK_DISABLED: 'false' }, 'traces'), 'http/protobuf')
  })

  test('each signal needs an endpoint and reads its own protocol over the shared one', () => {
    const env = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t:4318/traces',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
    }
    assert.equal(otlpProtocol(env, 'traces'), 'http/protobuf')
    assert.equal(otlpProtocol(env, 'logs'), null)
    const shared = { ...env, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }
    assert.equal(otlpProtocol(shared, 'logs'), 'http/json')
  })

  test("a signal's exporter of none turns it off, and grpc is refused", () => {
    const on = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }
    assert.equal(otlpProtocol({ ...on, OTEL_TRACES_EXPORTER: 'none' }, 'traces'), null)
    assert.equal(otlpProtocol({ ...on, OTEL_TRACES_EXPORTER: 'none' }, 'logs'), 'http/protobuf')
    assert.equal(otlpProtocol({ ...on, OTEL_METRICS_EXPORTER: 'console' }, 'metrics'), null)
    assert.match(
      JSON.stringify(otlpProtocol({ ...on, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, 'traces')),
      /over OTLP\/HTTP only.*grpc: set OTEL_EXPORTER_OTLP_PROTOCOL to http\/protobuf or http\/json/,
    )
  })
})

describe('host metrics', () => {
  test('samples CPU, memory, load and each filesystem once', () => {
    const host = new HostMetrics({
      project: process.cwd(),
      staging: process.cwd(),
      gone: '/no/such/dir',
    })
    const points = host.sample()
    for (const name of Object.keys(HOST_METRICS))
      assert.ok(
        points.some((p) => p.name === name),
        name,
      )
    assert.deepEqual(
      points.filter((p) => p.name === 'system.filesystem.utilization').map((p) => p.attributes),
      [{ 'reeval.filesystem.role': 'project' }],
    )
    assert.ok(!JSON.stringify(points).includes(process.cwd()))
    for (const p of host.sample()) assert.ok(Number.isFinite(p.value) && p.value >= 0, p.name)
  })
})

type Sent = { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }

/** A collector on loopback that answers with `answer`, keeping each JSON body. */
async function collector(
  t: TestContext,
  answer: (req: IncomingMessage, res: ServerResponse) => void = (_, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}'),
) {
  const sent: Sent[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      sent.push({
        path: req.url ?? '',
        headers: req.headers,
        body: req.headers['content-type'] === 'application/json' ? JSON.parse(text) : {},
      })
      answer(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent }
}

/** Sets `vars` in `process.env`, where the exporters read them, for this test only. */
function withEnv(t: TestContext, vars: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

const start = () =>
  startTelemetry({ version: '1.0.0', traceId: T, spanId: R, runId: 'r1', filesystems: {} })

// biome-ignore lint/suspicious/noExplicitAny: OTLP's JSON mapping, read loosely
type Json = any

const attributesOf = (list: Json[]) =>
  Object.fromEntries(list.map((a: Json) => [a.key, Object.values(a.value)[0]]))

describe('startTelemetry', () => {
  test('is null with nothing to export', (t) => {
    withEnv(t, {
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
    })
    assert.equal(start(), null)
  })

  test('sends spans with their own ids, times, parents and links, on the resource the variables name', async (t) => {
    const c = await collector(t)
    withEnv(t, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${c.url}/v1/traces`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc',
      OTEL_RESOURCE_ATTRIBUTES: 'service.name=a,team=evals%20ci',
      OTEL_SERVICE_NAME: 'evals',
    })
    const telemetry = start()
    assert.ok(telemetry)
    const span: RunSpan = {
      traceId: T,
      spanId: S,
      parentSpanId: P,
      name: 'lease',
      startMs: 1_794_500_000_000,
      endMs: 1_794_500_000_250,
      attributes: { 'host.id': 'vm-1', slot: 0, ok: true, ratio: 0.5 },
      status: { code: 'error', message: 'gone' },
      links: [{ traceId: T, spanId: L }],
    }
    telemetry.span(span)
    telemetry.span({
      traceId: T,
      spanId: R,
      name: 'reeval.run',
      startMs: 1,
      endMs: 2,
      attributes: {},
    })
    assert.equal(await telemetry.close(), null)
    assert.equal(c.sent.length, 1)
    assert.equal(c.sent[0]?.path, '/v1/traces')
    assert.equal(c.sent[0]?.headers.authorization, 'Bearer abc')
    const body: Json = c.sent[0]?.body
    const [resourceSpans] = body.resourceSpans
    assert.deepEqual(attributesOf(resourceSpans.resource.attributes), {
      'service.name': 'evals',
      team: 'evals ci',
    })
    assert.deepEqual(resourceSpans.scopeSpans[0].scope, { name: 'reeval', version: '1.0.0' })
    const [lease, root] = resourceSpans.scopeSpans[0].spans as Json[]
    assert.equal(lease.traceId, T)
    assert.equal(lease.spanId, S)
    assert.equal(lease.parentSpanId, P)
    assert.equal(String(lease.startTimeUnixNano), '1794500000000000000')
    assert.equal(String(lease.endTimeUnixNano), '1794500000250000000')
    assert.deepEqual(lease.status, { code: 2, message: 'gone' })
    assert.equal(lease.links[0].spanId, L)
    assert.deepEqual(attributesOf(lease.attributes), {
      'host.id': 'vm-1',
      slot: 0,
      ok: true,
      ratio: 0.5,
    })
    assert.ok(!root.parentSpanId, 'the run span is a root')
  })

  test("sends the run's notices and finished attempts as log records on the run's span", async (t) => {
    const c = await collector(t)
    withEnv(t, {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${c.url}/logs`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    })
    const telemetry = start()
    assert.ok(telemetry)
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`
    telemetry.event({ type: 'notice', at: 1, level: 'warn', text: `Budget reached ${token}` })
    telemetry.event({
      type: 'eval-end',
      at: 2,
      result: {
        id: 'e',
        key: 'k1',
        file: 'evals/a.eval.ts',
        group: [],
        name: 'writes hello',
        state: 'failed',
        durationMs: 12.4,
        errors: [`expected 1 to be 2 ${token}\nmore`],
        formattedErrors: [],
      },
    })
    telemetry.event({ type: 'log', at: 3, stream: 'stdout', text: 'user output stays out' })
    assert.equal(await telemetry.close(), null)
    assert.equal(c.sent.length, 1)
    assert.equal(c.sent[0]?.path, '/logs')
    const body: Json = c.sent[0]?.body
    const records: Json[] = body.resourceLogs[0].scopeLogs[0].logRecords
    assert.deepEqual(
      records.map((r) => [r.severityText, r.body.stringValue, r.traceId, r.spanId]),
      [
        ['WARN', 'Budget reached [REDACTED]', T, R],
        ['WARN', 'failed writes hello', T, R],
      ],
    )
    assert.deepEqual(attributesOf(records[1].attributes), {
      'reeval.run.id': 'r1',
      'reeval.event': 'attempt',
      'reeval.attempt.key': 'k1',
      'reeval.eval.name': 'writes hello',
      'reeval.eval.file': 'evals/a.eval.ts',
      'reeval.attempt.state': 'failed',
      'reeval.attempt.duration_ms': 12,
      'reeval.attempt.error': 'expected 1 to be 2 [REDACTED]',
    })
  })

  test('sends the host metrics when it closes, gauges and byte counters', async (t) => {
    const c = await collector(t)
    withEnv(t, {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${c.url}/v1/metrics`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    })
    const telemetry = start()
    assert.equal(await telemetry?.close(), null)
    const metrics = c.sent.flatMap(
      (s) => (s.body.resourceMetrics as Json[])[0].scopeMetrics[0].metrics as Json[],
    )
    const of = (name: string) => metrics.find((m) => m.name === name)
    assert.ok(of('system.cpu.utilization')?.gauge, JSON.stringify(metrics.map((m) => m.name)))
    assert.equal(of('system.memory.usage')?.sum.isMonotonic, false)
    assert.equal(of('system.memory.usage')?.sum.dataPoints.length, 2)
  })

  test('a refused export is a reason close gives, naming the signal and what was lost', async (t) => {
    const c = await collector(t, (_, res) => res.writeHead(400).end())
    withEnv(t, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${c.url}/v1/traces`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    })
    const telemetry = start()
    for (const id of [S, P, L])
      telemetry?.span({ traceId: T, spanId: id, name: 'x', startMs: 1, endMs: 2, attributes: {} })
    assert.equal(await telemetry?.close(), 'traces: the collector answered 400 (3 spans not sent)')
  })

  test('a refused protocol is a reason close gives, not a throw', async (t) => {
    withEnv(t, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })
    const telemetry = start()
    assert.match((await telemetry?.close()) ?? '', /grpc/)
  })

  test('close waits at most CLOSE_MS for a collector that never answers', async (t) => {
    const c = await collector(t, () => {})
    withEnv(t, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${c.url}/v1/traces`,
      OTEL_EXPORTER_OTLP_TIMEOUT: '120000',
    })
    const telemetry = start()
    telemetry?.span({ traceId: T, spanId: S, name: 'x', startMs: 1, endMs: 2, attributes: {} })
    const began = Date.now()
    assert.match((await telemetry?.close()) ?? '', /didn't take the rest within 5 s/)
    const took = Date.now() - began
    assert.ok(took >= CLOSE_MS - 100 && took < CLOSE_MS + 2000, String(took))
  })
})
