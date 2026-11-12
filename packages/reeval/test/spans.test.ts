// The run's trace, spans.jsonl: a fake run writes one with the run, its attempts and their phases
// under it, the record names it, recording keeps it with the run's evidence, and with
// OTEL_EXPORTER_OTLP_ENDPOINT set the run posts it to a collector as OTLP/HTTP JSON.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { otlpRequest, otlpTarget } from '../src/trace/otlp.ts'
import { traceIdOf } from '../src/trace/run.ts'
import { parseSpans, type RunSpan } from '../src/view/spans.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

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

  test('with OTEL_EXPORTER_OTLP_ENDPOINT set, the run posts its spans as OTLP JSON', async (t) => {
    const bodies: Array<{ url: string; auth: string | undefined; body: unknown }> = []
    const server = createServer((req, res) => {
      let data = ''
      req.on('data', (d) => {
        data += d
      })
      req.on('end', () => {
        bodies.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(data) })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const { port } = server.address() as AddressInfo

    const p = await fakeProject('spans-otlp')
    const r = await runCli(p.dir, ['run'], {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/`,
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc',
        OTEL_SERVICE_NAME: 'evals',
      },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(bodies.length, 1)
    const [sent] = bodies
    assert.equal(sent?.url, '/v1/traces')
    assert.equal(sent?.auth, 'Bearer abc')
    const request = sent?.body as ReturnType<typeof otlpRequest>
    const [resource] = request.resourceSpans
    assert.deepEqual(resource?.resource.attributes, [
      { key: 'service.name', value: { stringValue: 'evals' } },
    ])
    const sentSpans = resource?.scopeSpans[0]?.spans ?? []
    const { read } = readRun(p.dir)
    const written = parseSpans(read('spans.jsonl'))
    assert.deepEqual(sentSpans.map((s) => s.spanId).sort(), written.map((s) => s.spanId).sort())
    const root = sentSpans.find((s) => s.name === 'reeval.run')
    assert.match(root?.startTimeUnixNano ?? '', /^\d{19}$/)
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

describe('OTLP target', () => {
  test('reads the standard variables', () => {
    assert.equal(otlpTarget({}), null)
    assert.equal(
      otlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_TRACES_EXPORTER: 'none' }),
      null,
    )
    const target = otlpTarget({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t:4318/traces',
      OTEL_EXPORTER_OTLP_HEADERS: 'a=1,b=x%3Dy',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'b=2',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=ci',
      OTEL_EXPORTER_OTLP_TIMEOUT: '500',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    })
    assert.deepEqual(target, {
      url: 'http://t:4318/traces',
      headers: { a: '1', b: '2' },
      serviceName: 'reeval',
      resource: { 'deployment.environment': 'ci' },
      timeoutMs: 500,
    })
    assert.match(
      String(
        otlpTarget({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        }),
      ),
      /OTLP\/HTTP as JSON only.*grpc: set it to http\/json/,
    )
  })

  test('maps a span to OTLP JSON', () => {
    const [span] =
      otlpRequest(
        [
          {
            traceId: 'a'.repeat(32),
            spanId: 'b'.repeat(16),
            parentSpanId: 'c'.repeat(16),
            name: 'lease',
            startMs: 1_794_500_000_000,
            endMs: 1_794_500_000_250,
            attributes: { 'host.id': 'vm-1', 'reeval.machine.slot': 0, ok: true, ratio: 0.5 },
            status: { code: 'error', message: 'gone' },
            links: [{ traceId: 'a'.repeat(32), spanId: 'd'.repeat(16) }],
          },
        ],
        { url: '', headers: {}, serviceName: 'reeval', resource: {}, timeoutMs: 1 },
        '1.0.0',
      ).resourceSpans[0]?.scopeSpans[0]?.spans ?? []
    assert.deepEqual(span, {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      name: 'lease',
      kind: 1,
      startTimeUnixNano: '1794500000000000000',
      endTimeUnixNano: '1794500000250000000',
      attributes: [
        { key: 'host.id', value: { stringValue: 'vm-1' } },
        { key: 'reeval.machine.slot', value: { intValue: '0' } },
        { key: 'ok', value: { boolValue: true } },
        { key: 'ratio', value: { doubleValue: 0.5 } },
      ],
      links: [{ traceId: 'a'.repeat(32), spanId: 'd'.repeat(16) }],
      status: { code: 2, message: 'gone' },
    })
  })
})
