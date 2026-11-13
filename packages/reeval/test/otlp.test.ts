// OpenTelemetry export without a run: each signal's target from the standard variables, the
// protobuf encoding against OpenTelemetry's own encoder, the batch processor, the host metrics and
// the log records a run's events become.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import {
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from '@opentelemetry/otlp-transformer'
import { Batcher, batchOptions } from '../src/trace/batch.ts'
import { HostMetrics } from '../src/trace/host-metrics.ts'
import {
  logsRequest,
  metricsRequest,
  type OtlpLog,
  type OtlpMetric,
  type OtlpTarget,
  otlpBody,
  otlpConfigured,
  otlpResource,
  otlpTarget,
  postOtlp,
  shownUrl,
  tracesRequest,
} from '../src/trace/otlp.ts'
import { startTelemetry } from '../src/trace/telemetry.ts'
import type { RunSpan } from '../src/view/spans.ts'
import { wireTree, withoutField } from './support/protobuf-wire.ts'

const T = 'a'.repeat(32)
const S = 'b'.repeat(16)
const P = 'c'.repeat(16)
const L = 'd'.repeat(16)
const res = { 'deployment.environment': 'ci', 'service.name': 'evals' }
const sdkResource = { attributes: res, asyncAttributesPending: false }
const scope = { name: 'reeval', version: '1.0.0' }
const hr = (ms: number): [number, number] => [Math.floor(ms / 1000), (ms % 1000) * 1e6]
const proto = (signal: OtlpTarget['signal']): OtlpTarget => ({
  signal,
  url: 'http://c/v1/x',
  headers: {},
  protocol: 'http/protobuf',
  gzip: false,
  timeoutMs: 1000,
})

describe('OTLP target', () => {
  test('nothing is configured without an endpoint, or with the SDK off', () => {
    assert.equal(otlpConfigured({}), false)
    assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://c' }), true)
    assert.equal(
      otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_SDK_DISABLED: 'true' }),
      false,
    )
    assert.equal(otlpTarget({}), null)
    const on = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }
    assert.equal(otlpTarget({ ...on, OTEL_SDK_DISABLED: 'true' }), null)
    assert.equal(typeof otlpTarget({ ...on, OTEL_SDK_DISABLED: 'false' }), 'object')
  })

  test('each signal reads its own variables over the shared ones, protobuf by default', () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318/',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t:4318/traces',
      OTEL_EXPORTER_OTLP_HEADERS: 'a=1,b=x%3Dy',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'b=2',
      OTEL_EXPORTER_OTLP_TIMEOUT: '500',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: 'gzip',
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '900',
    }
    assert.deepEqual(otlpTarget(env, 'traces'), {
      signal: 'traces',
      url: 'http://t:4318/traces',
      headers: { a: '1', b: '2' },
      protocol: 'http/protobuf',
      gzip: false,
      timeoutMs: 500,
    })
    assert.deepEqual(otlpTarget(env, 'logs'), {
      signal: 'logs',
      url: 'http://c:4318/v1/logs',
      headers: { a: '1', b: 'x=y' },
      protocol: 'http/json',
      gzip: false,
      timeoutMs: 500,
    })
    assert.deepEqual(otlpTarget(env, 'metrics'), {
      signal: 'metrics',
      url: 'http://c:4318/v1/metrics',
      headers: { a: '1', b: 'x=y' },
      protocol: 'http/protobuf',
      gzip: true,
      timeoutMs: 900,
    })
  })

  test('an empty per-signal timeout leaves the shared one', () => {
    const t = otlpTarget({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
      OTEL_EXPORTER_OTLP_TIMEOUT: '2500',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '',
    })
    assert.equal(typeof t === 'object' && t?.timeoutMs, 2500)
  })

  test("a signal's exporter of none turns it off; grpc and unknown compression are refused", () => {
    const on = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }
    assert.equal(otlpTarget({ ...on, OTEL_TRACES_EXPORTER: 'none' }, 'traces'), null)
    assert.equal(typeof otlpTarget({ ...on, OTEL_TRACES_EXPORTER: 'none' }, 'logs'), 'object')
    assert.equal(otlpTarget({ ...on, OTEL_METRICS_EXPORTER: 'console' }, 'metrics'), null)
    assert.match(
      String(otlpTarget({ ...on, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })),
      /over OTLP\/HTTP only.*grpc: set OTEL_EXPORTER_OTLP_PROTOCOL to http\/protobuf or http\/json/,
    )
    assert.match(
      String(otlpTarget({ ...on, OTEL_EXPORTER_OTLP_COMPRESSION: 'zstd' })),
      /gzip or none.*zstd/,
    )
  })

  test('the resource is OTEL_RESOURCE_ATTRIBUTES with OTEL_SERVICE_NAME over its service.name', () => {
    assert.deepEqual(otlpResource({}), { 'service.name': 'reeval' })
    assert.deepEqual(otlpResource({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=a,team=evals%20ci' }), {
      'service.name': 'a',
      team: 'evals ci',
    })
    assert.deepEqual(
      otlpResource({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=a', OTEL_SERVICE_NAME: 'b' }),
      { 'service.name': 'b' },
    )
  })

  test('a message shows the URL without its credentials', () => {
    assert.equal(
      shownUrl('https://user:pass@c.example:4318/v1/traces?token=abc'),
      'https://c.example:4318/v1/traces',
    )
  })
})

describe('OTLP protobuf', () => {
  const attributes = { 'host.id': 'vm-1', slot: 0, n: 3, ok: true, ratio: 0.5, neg: -2 }

  test('a span encodes as OpenTelemetry encodes it', () => {
    const span: RunSpan = {
      traceId: T,
      spanId: S,
      parentSpanId: P,
      name: 'lease',
      startMs: 1_794_500_000_000,
      endMs: 1_794_500_000_250,
      attributes,
      status: { code: 'error', message: 'gone' },
      links: [{ traceId: T, spanId: L }],
    }
    const theirs = ProtobufTraceSerializer.serializeRequest([
      {
        name: 'lease',
        kind: 0,
        spanContext: () => ({ traceId: T, spanId: S, traceFlags: 1 }),
        parentSpanContext: { traceId: T, spanId: P, traceFlags: 1 },
        startTime: hr(span.startMs),
        endTime: hr(span.endMs),
        status: { code: 2, message: 'gone' },
        attributes,
        links: [{ context: { traceId: T, spanId: L, traceFlags: 1 }, attributes: {} }],
        events: [],
        duration: [0, 250e6],
        ended: true,
        resource: sdkResource,
        instrumentationScope: scope,
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
      } as never,
    ]) as Uint8Array
    const ours = otlpBody(proto('traces'), tracesRequest([span], res, '1.0.0')).body
    // reeval sends no trace flags: the span's (16) and its links' (6).
    const expected = withoutField(withoutField(wireTree(theirs), [1, 2, 2, 16]), [1, 2, 2, 13, 6])
    assert.deepEqual(wireTree(ours), expected)
  })

  test('a log record encodes as OpenTelemetry encodes it', () => {
    const log: OtlpLog = {
      timeMs: 1_794_500_000_123,
      severity: 'WARN',
      body: 'failed x',
      attributes,
      traceId: T,
    }
    const theirs = ProtobufLogsSerializer.serializeRequest([
      {
        hrTime: hr(log.timeMs),
        hrTimeObserved: hr(log.timeMs),
        spanContext: { traceId: T, spanId: '', traceFlags: 0 },
        severityText: 'WARN',
        severityNumber: 13,
        body: 'failed x',
        attributes,
        droppedAttributesCount: 0,
        resource: sdkResource,
        instrumentationScope: scope,
      } as never,
    ]) as Uint8Array
    const ours = otlpBody(proto('logs'), logsRequest([log], res, '1.0.0')).body
    assert.deepEqual(wireTree(ours), wireTree(theirs))
  })

  test('a gauge and an up-down counter encode as OpenTelemetry encodes them', () => {
    const startMs = 1_794_500_000_000
    const timeMs = 1_794_500_015_000
    const metrics: OtlpMetric[] = [
      {
        name: 'system.cpu.utilization',
        unit: '1',
        description: 'cpu',
        type: 'gauge',
        startMs,
        timeMs,
        points: [{ value: 0.25 }],
      },
      {
        name: 'system.memory.usage',
        unit: 'By',
        description: 'mem',
        type: 'updown',
        startMs,
        timeMs,
        points: [
          { value: 1024, int: true, attributes: { 'system.memory.state': 'used' } },
          { value: 0, int: true, attributes: { 'system.memory.state': 'free' } },
        ],
      },
    ]
    const point = (value: number, attrs = {}) => ({
      startTime: hr(startMs),
      endTime: hr(timeMs),
      attributes: attrs,
      value,
    })
    const theirs = ProtobufMetricsSerializer.serializeRequest({
      resource: sdkResource,
      scopeMetrics: [
        {
          scope,
          metrics: [
            {
              descriptor: {
                name: 'system.cpu.utilization',
                description: 'cpu',
                unit: '1',
                valueType: 1,
              },
              aggregationTemporality: 1,
              dataPointType: 2,
              dataPoints: [point(0.25)],
            },
            {
              descriptor: {
                name: 'system.memory.usage',
                description: 'mem',
                unit: 'By',
                valueType: 0,
              },
              aggregationTemporality: 1,
              dataPointType: 3,
              isMonotonic: false,
              dataPoints: [
                point(1024, { 'system.memory.state': 'used' }),
                point(0, { 'system.memory.state': 'free' }),
              ],
            },
          ],
        },
      ],
    } as never) as Uint8Array
    const ours = otlpBody(proto('metrics'), metricsRequest(metrics, res, '1.0.0')).body
    assert.deepEqual(wireTree(ours), wireTree(theirs))
  })

  test('gzip compresses the body, and JSON is the JSON mapping', () => {
    const request = logsRequest(
      [{ timeMs: 1, severity: 'INFO', body: 'hi', attributes: {} }],
      res,
      '1',
    )
    const plain = otlpBody(proto('logs'), request)
    const zipped = otlpBody({ ...proto('logs'), gzip: true }, request)
    assert.deepEqual(new Uint8Array(gunzipSync(zipped.body)), plain.body)
    const json = otlpBody({ ...proto('logs'), protocol: 'http/json' }, request)
    assert.equal(json.contentType, 'application/json')
    assert.deepEqual(JSON.parse(new TextDecoder().decode(json.body)), request)
  })
})

describe('postOtlp', () => {
  test('sends the headers and content type, and never throws', async () => {
    let seen: RequestInit | undefined
    const ok = (async (_url: string, init: RequestInit) => {
      seen = init
      return new Response('{}')
    }) as typeof fetch
    const target = { ...proto('logs'), gzip: true, headers: { authorization: 'Bearer abc' } }
    assert.equal(await postOtlp(target, logsRequest([], res, '1'), ok), null)
    assert.deepEqual(seen?.headers, {
      'content-type': 'application/x-protobuf',
      'content-encoding': 'gzip',
      authorization: 'Bearer abc',
    })
    const refused = (async () => new Response('', { status: 401 })) as typeof fetch
    assert.equal(await postOtlp(target, {}, refused), 'http://c/v1/x answered 401')
    const down = (async () => {
      throw new Error('connect ECONNREFUSED http://user:pw@c/v1/x')
    }) as typeof fetch
    const user = { ...target, url: 'http://user:pw@c/v1/x' }
    assert.equal(
      await postOtlp(user, {}, down),
      "couldn't reach http://c/v1/x: connect ECONNREFUSED http://c/v1/x",
    )
  })
})

describe('Batcher', () => {
  const options = { delayMs: 30, maxBatch: 3, maxQueue: 10 }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test('reads the SDK variables, with its defaults', () => {
    assert.deepEqual(batchOptions({}, 'BSP'), { delayMs: 5000, maxQueue: 2048, maxBatch: 512 })
    assert.deepEqual(batchOptions({}, 'BLRP'), { delayMs: 1000, maxQueue: 2048, maxBatch: 512 })
    assert.deepEqual(
      batchOptions(
        {
          OTEL_BSP_SCHEDULE_DELAY: '50',
          OTEL_BSP_MAX_QUEUE_SIZE: '100',
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '500',
        },
        'BSP',
      ),
      { delayMs: 50, maxQueue: 100, maxBatch: 100 },
    )
  })

  test('sends a full batch at once and the rest after the delay, one request at a time', async () => {
    const sent: number[][] = []
    let inFlight = 0
    const b = new Batcher<number>(
      async (items) => {
        inFlight++
        assert.equal(inFlight, 1, 'one request at a time')
        sent.push(items)
        await sleep(5)
        inFlight--
        return null
      },
      options,
      'items',
    )
    for (const i of [1, 2, 3, 4]) b.add(i)
    await sleep(1)
    assert.deepEqual(sent, [[1, 2, 3]], 'the full batch goes before the delay')
    await sleep(60)
    assert.deepEqual(sent, [[1, 2, 3], [4]], 'the rest goes after it')
    b.add(5)
    assert.equal(await b.close(), null)
    assert.deepEqual(sent, [[1, 2, 3], [4], [5]], 'close sends what is queued')
    b.add(6)
    assert.equal(sent.length, 3, 'a closed batcher takes no more')
  })

  test('a refused batch is dropped and named, close drops the rest, and a full queue drops new items', async () => {
    let calls = 0
    const refusing = new Batcher<number>(
      async () => (++calls === 1 ? 'http://c answered 503' : null),
      { delayMs: 10_000, maxBatch: 2, maxQueue: 10 },
      'spans',
    )
    for (const i of [1, 2, 3, 4, 5]) refusing.add(i)
    assert.equal(await refusing.close(), 'http://c answered 503 (5 of 5 spans not sent)')
    assert.equal(calls, 1, "close doesn't wait on a collector that just failed")

    const full = new Batcher<number>(
      async () => null,
      { delayMs: 10_000, maxBatch: 5, maxQueue: 3 },
      'spans',
    )
    for (const i of [1, 2, 3, 4]) full.add(i)
    assert.equal(await full.close(), 'the queue of 3 spans was full (1 of 4 spans not sent)')
  })
})

describe('Batcher backoff', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test('after a failure the next batch waits twice the delay, and a success resets it', async () => {
    const at: number[] = []
    const started = Date.now()
    let calls = 0
    const b = new Batcher<number>(
      async () => {
        at.push(Date.now() - started)
        return ++calls === 1 ? 'http://c answered 503' : null
      },
      { delayMs: 40, maxBatch: 2, maxQueue: 10 },
      'spans',
    )
    b.add(1)
    b.add(2)
    await sleep(5)
    assert.equal(calls, 1, 'the full batch went at once, and failed')
    b.add(3)
    b.add(4)
    await sleep(50)
    assert.equal(calls, 1, 'a full batch after a failure waits for the backoff')
    await sleep(60)
    assert.equal(calls, 2, 'it goes after twice the delay')
    assert.ok((at[1] ?? 0) >= 75, String(at))
    b.add(5)
    b.add(6)
    await sleep(5)
    assert.equal(calls, 3, 'after a success a full batch goes at once again')
    assert.equal(await b.close(), 'http://c answered 503 (2 of 6 spans not sent)')
  })
})

describe('host metrics', () => {
  test('samples CPU, memory, load and each filesystem once', () => {
    const host = new HostMetrics([process.cwd(), process.cwd(), '/no/such/dir'])
    const names = host.sample().map((m) => m.name)
    for (const name of [
      'system.cpu.utilization',
      'system.cpu.load_average.1m',
      'system.memory.usage',
      'system.memory.utilization',
      'process.cpu.utilization',
      'process.memory.usage',
      'system.filesystem.usage',
      'system.filesystem.utilization',
    ])
      assert.equal(names.filter((n) => n === name).length, 1, name)
    for (const m of host.sample())
      for (const p of m.points) assert.ok(Number.isFinite(p.value) && p.value >= 0, m.name)
  })
})

describe('startTelemetry', () => {
  test('is null with nothing to export', () => {
    assert.equal(startTelemetry({ env: {}, version: '1', traceId: T, runId: 'r', paths: [] }), null)
  })

  test("sends the run's notices and finished attempts as log records on its trace", async () => {
    const bodies: Array<{ url: string; body: ReturnType<typeof logsRequest> }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) })
      return new Response('{}')
    }) as typeof fetch
    const telemetry = startTelemetry({
      env: {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://c/logs',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      },
      version: '1',
      traceId: T,
      runId: 'r1',
      paths: [],
      fetcher,
    })
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
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0]?.url, 'http://c/logs')
    const records = bodies[0]?.body.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []
    assert.deepEqual(
      records.map((r) => [r.severityText, r.body.stringValue, r.traceId]),
      [
        ['WARN', 'Budget reached [REDACTED]', T],
        ['WARN', 'failed writes hello', T],
      ],
    )
    const attrs = Object.fromEntries(
      (records[1]?.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]),
    )
    assert.deepEqual(attrs, {
      'reeval.run.id': 'r1',
      'reeval.event': 'attempt',
      'reeval.attempt.key': 'k1',
      'reeval.eval.name': 'writes hello',
      'reeval.eval.file': 'evals/a.eval.ts',
      'reeval.attempt.state': 'failed',
      'reeval.attempt.duration_ms': '12',
      'reeval.attempt.error': 'expected 1 to be 2 [REDACTED]',
    })
  })

  test('a refused protocol is a reason close gives, not a throw', async () => {
    const telemetry = startTelemetry({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
      version: '1',
      traceId: T,
      runId: 'r',
      paths: [],
    })
    assert.match((await telemetry?.close()) ?? '', /grpc/)
  })
})
