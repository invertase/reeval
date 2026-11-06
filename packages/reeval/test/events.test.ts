// A run's event stream: what `reeval run --events` and `--events-url` write, and how `reeval attach`
// follows it (mid-run, across a resume, from a URL) and ends with the run's exit code.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { attach } from '../src/attach.ts'
import { EventStreamError, openEventStream } from '../src/events.ts'
import type { ReevalEvent } from '../src/ui/events.ts'
import type { OutputOptions } from '../src/ui/mode.ts'
import type { RunEventLine } from '../src/view/events.ts'
import { NewerSchemaError } from '../src/view/record.ts'
import { baseEnv, noSignals, pkgRoot, project, runCli, tempDir } from './helpers.ts'

const output: OutputOptions = {
  mode: 'plain',
  statusLine: false,
  logOrder: 'stream',
  logPrefix: 'task',
  outputLogs: 'full',
  color: false,
  githubActions: false,
  heartbeatMs: 0,
  interactive: false,
}

const header = (runId = 'run-1') => ({
  reeval: '0.1.0',
  runId,
  startedAt: '2026-01-01T00:00:00.000Z',
  harness: 'fake',
  verbosity: 0 as const,
})

const notice = (text: string): ReevalEvent => ({ type: 'notice', at: 1, level: 'warn', text })

const capture = () => {
  const out = { text: '', write: (chunk: string) => (out.text += chunk) }
  return out
}

const readLines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RunEventLine)

describe('the stream', () => {
  test('a header line with its schema version, the events, then the exit code', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail })
    stream.write(notice('hello'))
    await stream.end(3)
    stream.write(notice('after the end'))
    const [first, second, last, ...more] = readLines(file)
    assert.deepEqual(
      { ...first, pid: 0 },
      {
        type: 'header',
        schemaVersion: 1,
        pid: 0,
        host: hostname(),
        ...header(),
      },
    )
    assert.equal(second?.type, 'notice')
    assert.deepEqual({ ...last, at: 0 }, { type: 'exit', at: 0, code: 3 })
    assert.deepEqual(more, [])
  })

  test('masks secret-shaped values, as the terminal does', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail })
    const key = `sk-ant-${'a'.repeat(40)}`
    stream.write({ type: 'log', at: 1, stream: 'stdout', text: `key=${key}\n` })
    await stream.end(0)
    assert.ok(!readFileSync(file, 'utf8').includes(key))
    assert.match(readFileSync(file, 'utf8'), /\[REDACTED\]/)
  })

  test("a prepare event keeps what the terminal shows, not preflight's handles", async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail })
    const target = { kind: 'docker', key: 'k', label: 'docker', setBy: ['config'], runWide: true }
    stream.write({
      type: 'prepare',
      at: 1,
      state: 'ready',
      outcome: {
        ok: true,
        ms: 5,
        target: { ...target, sandbox: { kind: 'docker' } },
        handle: { close() {} },
      },
    } as never)
    await stream.end(0)
    const line = readLines(file)[1] as Extract<RunEventLine, { type: 'prepare' }>
    assert.deepEqual(line, {
      type: 'prepare',
      at: 1,
      state: 'ready',
      outcome: { ok: true, ms: 5, target },
    })
  })

  test('a failing URL warns once and the run goes on', async () => {
    const warnings: string[] = []
    const stream = openEventStream({
      url: 'http://127.0.0.1:9/events',
      header: header(),
      warn: (w) => warnings.push(w),
      fetch: async () => new Response('no', { status: 500 }),
    })
    stream.write(notice('a'))
    await sleep(20)
    stream.write(notice('b'))
    await stream.end(0)
    assert.equal(warnings.length, 1)
    assert.match(
      warnings[0] ?? '',
      /stopped posting the event stream to http:\/\/127\.0\.0\.1:9\/events: HTTP 500/,
    )
  })

  test("a file it can't open warns and the run goes on", async () => {
    const dir = tempDir('events')
    writeFileSync(join(dir, 'file'), '')
    const warnings: string[] = []
    const stream = openEventStream({
      file: join(dir, 'file', 'events.ndjson'),
      header: header(),
      warn: (w) => warnings.push(w),
    })
    stream.write(notice('a'))
    await stream.end(0)
    assert.match(warnings.join('\n'), /can't write the event stream to /)
  })
})

describe('attach', () => {
  test('follows lines appended after it started, until the exit line', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail })
    stream.write(notice('before'))
    const out = capture()
    const done = attach({ source: file, out, output: () => output, follow: { pollMs: 10 } })
    await sleep(50)
    assert.match(out.text, /before/)
    stream.write(notice('after'))
    await sleep(50)
    assert.match(out.text, /after/)
    await stream.end(130)
    assert.equal(await done, 130)
  })

  test("a resume's lines follow the run's exit line: it draws both and exits with the last code", async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const first = openEventStream({ file, header: header(), warn: assert.fail })
    first.write(notice('first part'))
    await first.end(130)
    const resumed = openEventStream({ file, append: true, header: header(), warn: assert.fail })
    resumed.write(notice('second part'))
    await resumed.end(0)
    const out = capture()
    assert.equal(await attach({ source: file, out, output: () => output }), 0)
    assert.match(out.text, /first part[\s\S]*second part/)
    // A new run with the same file starts it anew.
    const fresh = openEventStream({ file, header: header('run-2'), warn: assert.fail })
    await fresh.end(1)
    assert.equal(readLines(file).length, 2)
  })

  test('a run whose process died without an exit line ends attach with an error', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail })
    stream.write(notice('last words'))
    const out = capture()
    await assert.rejects(
      attach({
        source: file,
        out,
        output: () => output,
        follow: { pollMs: 10, alive: () => false },
      }),
      (error: Error) =>
        error instanceof EventStreamError &&
        /run run-1's reeval run \(pid \d+\) ended without finishing its event stream/.test(
          error.message,
        ),
    )
    assert.match(out.text, /last words/)
  })

  test('a stream from a newer reeval is refused, naming the upgrade', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'header', schemaVersion: 2, runId: 'run-9', reeval: '9.0.0' })}\n`,
    )
    await assert.rejects(
      attach({ source: file, out: capture(), output: () => output }),
      (error: Error) =>
        error instanceof NewerSchemaError && /Upgrade reeval to read it/.test(error.message),
    )
  })

  test("a line that isn't JSON is refused", async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    writeFileSync(file, 'not json\n')
    await assert.rejects(
      attach({ source: file, out: capture(), output: () => output }),
      /has a line that isn't JSON: not json/,
    )
  })

  test('posts to a URL and follows it there, as a relay serves the posted lines', async () => {
    const lines: string[] = []
    const readers = new Set<ServerResponse>()
    const server = createServer((req, res) => {
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          assert.equal(req.headers['content-type'], 'application/x-ndjson')
          lines.push(body)
          for (const r of readers) r.write(body)
          if (body.includes('"type":"exit"')) for (const r of readers) r.end()
          res.end()
        })
        return
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(lines.join(''))
      readers.add(res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`
    try {
      const stream = openEventStream({ url, header: header(), warn: assert.fail })
      stream.write(notice('over http'))
      await sleep(50)
      const out = capture()
      const done = attach({ source: url, out, output: () => output })
      await sleep(50)
      stream.write(notice('then more'))
      await stream.end(1)
      assert.equal(await done, 1)
      assert.match(out.text, /over http[\s\S]*then more/)
    } finally {
      server.close()
    }
  })

  test('a URL whose response ends before the exit line is an error', async () => {
    await assert.rejects(
      attach({
        source: 'http://relay.test/events',
        out: capture(),
        output: () => output,
        follow: {
          fetch: async () =>
            new Response(
              `${JSON.stringify({ type: 'header', schemaVersion: 1, ...header(), pid: 1, host: 'x' })}\n`,
            ),
        },
      }),
      /the event stream at http:\/\/relay\.test\/events ended before the run did/,
    )
    await assert.rejects(
      attach({
        source: 'http://relay.test/events',
        out: capture(),
        output: () => output,
        follow: { fetch: async () => new Response('gone', { status: 404 }) },
      }),
      /can't read the event stream at http:\/\/relay\.test\/events: HTTP 404/,
    )
  })
})

const config = `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({ harnesses: fakeHarness({}), sandbox: fakeSandbox() })
`

/** One eval that waits for `go` beside the config, so a test can attach while it runs. */
const gated = `
import { existsSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
evaluate('waits', async (c) => {
  while (!existsSync(new URL('../go', import.meta.url))) await new Promise((r) => setTimeout(r, 50))
  expect(c.attempt.n).toBe(1)
})
`

describe('reeval run --events and reeval attach', () => {
  test('attach with no argument finds the run in progress, then exits with its code', async () => {
    const p = await project('events-cli', {
      'reeval.config.ts': config,
      'evals/waits.eval.ts': gated,
    })
    const run = spawn(process.execPath, [join(pkgRoot, 'dist/cli.js'), 'run', '--events'], {
      cwd: p.dir,
      env: baseEnv,
    })
    let ran = ''
    run.stdout.on('data', (d) => (ran += d))
    const exited = new Promise<number | null>((resolve) => run.on('close', resolve))
    try {
      // Until the run has started, attach finds nothing in progress.
      for (let i = 0; i < 200 && !ran.includes('Running'); i++) await sleep(50)
      const attaching = runCli(p.dir, ['attach'])
      await sleep(500)
      writeFileSync(join(p.dir, 'go'), '')
      const attached = await attaching
      assert.equal(await exited, 0)
      assert.equal(attached.code, 0, attached.stderr)
      assert.equal(attached.stdout, ran)
      assert.match(attached.stdout, /✓ waits/)
    } finally {
      run.kill()
    }
    const id = /Run: +(\S+)/.exec(ran)?.[1] ?? ''
    assert.ok(existsSync(join(p.dir, '.reeval', 'events', `${id}.ndjson`)))
    // Once it's done, a prefix of its id replays it.
    const again = await runCli(p.dir, ['attach', id.slice(0, 20)])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(again.stdout, ran)
  })

  test('a resume appends to the stream the run started, without --events', {
    skip: noSignals,
  }, async () => {
    const p = await project('events-resume', {
      'reeval.config.ts': config,
      'evals/waits.eval.ts': gated,
    })
    const file = join(p.dir, 'out', 'events.ndjson')
    const stopped = await runCli(p.dir, ['run', '--events', 'out/events.ndjson'], {
      onOutput: (stdout, pid) => {
        if (!stdout.includes('Running')) return false
        process.kill(pid, 'SIGINT')
        return true
      },
    })
    assert.equal(stopped.code, 130, stopped.stderr)
    writeFileSync(join(p.dir, 'go'), '')
    const resumed = await runCli(p.dir, ['run', '--resume'])
    assert.equal(resumed.code, 0, resumed.stderr)
    const lines = readLines(file)
    const exits = lines.flatMap((l) => (l.type === 'exit' ? [l.code] : []))
    const runs = lines.flatMap((l) => (l.type === 'header' ? [l.runId] : []))
    assert.deepEqual(exits, [130, 0])
    assert.equal(runs.length, 2)
    assert.equal(runs[0], runs[1], 'the same run')
    const attached = await runCli(p.dir, ['attach', 'out/events.ndjson'])
    assert.equal(attached.code, 0, attached.stderr)
    assert.equal(attached.stdout, stopped.stdout + resumed.stdout)
  })

  test('attach names what it can not find', async () => {
    const p = await project('events-none', {
      'reeval.config.ts': config,
      'evals/waits.eval.ts': gated,
    })
    const none = await runCli(p.dir, ['attach'])
    assert.equal(none.code, 2)
    assert.match(none.stderr, /No run in progress to attach to/)
    const unknown = await runCli(p.dir, ['attach', 'nope'])
    assert.equal(unknown.code, 2)
    assert.match(unknown.stderr, /No run, stream file or URL matches "nope"/)
    const url = await runCli(p.dir, ['run', '--events-url', 'ftp://x'])
    assert.equal(url.code, 2)
    assert.match(url.stderr, /--events-url takes an http or https URL \(got ftp:\/\/x\)/)
    // A run without --events has no stream to attach to.
    writeFileSync(join(p.dir, 'go'), '')
    const plain = await runCli(p.dir, ['run'])
    assert.equal(plain.code, 0, plain.stderr)
    const id = /Run: +(\S+)/.exec(plain.stdout)?.[1] ?? ''
    const missing = await runCli(p.dir, ['attach', id])
    assert.equal(missing.code, 2)
    assert.match(
      missing.stderr,
      new RegExp(`run ${id} has no event stream: reeval run --events writes one`),
    )
  })
})
