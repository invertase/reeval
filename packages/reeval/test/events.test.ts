// A run's event stream: what `reeval run --events` and `--events-url` write, and how `reeval attach`
// follows it (mid-run, across a resume, over a WebSocket) and ends with the run's exit code.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { attach, viewerEvent, viewerPath } from '../src/attach.ts'
import { EventStreamError, openEventStream } from '../src/events.ts'
import { stripAnsi } from '../src/ui/colors.ts'
import type { ReevalEvent, RunHeader } from '../src/ui/events.ts'
import type { OutputOptions } from '../src/ui/mode.ts'
import type { RunEventLine, RunEventsHeader } from '../src/view/events.ts'
import { NewerSchemaError } from '../src/view/record.ts'
import { baseEnv, noSignals, pkgRoot, project, readRun, runCli, tempDir } from './helpers.ts'

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

/** Until `ready()`, checked every few milliseconds, for at most 10s. */
const waitFor = async (ready: () => boolean) => {
  for (const deadline = Date.now() + 10_000; !ready(); await sleep(5)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${ready}`)
  }
}

/**
 * A relay that takes `--events-url` POSTs, numbers each line
 * from 1, and serves them on a WebSocket as `{"seq":n,"line":…}` frames after `?after=`. It closes
 * with 1000 once the run is over: after its exit line, or with `resumes`, at `finish()`.
 */
async function relay(
  options: { maxViewers?: number; closeAtOnce?: boolean; resumes?: boolean } = {},
) {
  const lines: string[] = []
  const afters: string[] = []
  const viewers = new Set<WebSocket>()
  let sent = 0
  let refusing = false
  let over = false
  const finish = () => {
    over = true
    for (const v of viewers) v.close(1000)
  }
  const send = (ws: WebSocket, seq: number) => {
    ws.send(`{"seq":${seq},"line":${lines[seq - 1]}}`)
    sent++
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      assert.equal(req.headers['content-type'], 'application/x-ndjson')
      for (const l of body.split('\n').filter(Boolean)) {
        lines.push(l)
        for (const v of viewers) send(v, lines.length)
        if (!options.resumes && l.includes('"type":"exit"')) finish()
      }
      res.end()
    })
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (refusing) return socket.destroy()
    sockets.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const after = new URL(req.url ?? '', 'http://relay').searchParams.get('after') ?? ''
      afters.push(after)
      if (options.maxViewers !== undefined && viewers.size >= options.maxViewers) {
        return ws.close(4429, `${options.maxViewers} viewers per run`)
      }
      viewers.add(ws)
      ws.on('close', () => viewers.delete(ws))
      for (let seq = Number(after) + 1; seq <= lines.length; seq++) send(ws, seq)
      if (options.closeAtOnce || over) ws.close(1000)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
    lines,
    afters,
    get sent() {
      return sent
    },
    drop: () => {
      for (const v of viewers) v.terminate()
    },
    finish,
    refuseUpgrades: () => {
      refusing = true
    },
    close: async () => {
      for (const v of viewers) v.terminate()
      sockets.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** An attempt key's eval name: `quick` for `evals/both.eval.ts › quick # fake/-/fake#1`. */
const nameOf = (key: string) => (key.split(' › ').at(-1) ?? '').split(' # ')[0] ?? ''
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
        heartbeatMs: 5000,
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

  test('masks a secret the environment holds in its strings, as a record is masked', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const secret = '271828182845'
    process.env.REEVAL_EVENTS_TEST_TOKEN = secret
    try {
      const stream = openEventStream({ file, header: header(), warn: assert.fail })
      stream.write({ type: 'log', at: Number(secret), stream: 'stdout', text: `t=${secret}\n` })
      await stream.end(0)
    } finally {
      delete process.env.REEVAL_EVENTS_TEST_TOKEN
    }
    const log = readLines(file)[1] as Extract<RunEventLine, { type: 'log' }>
    assert.ok(!log.text.includes(secret))
    // Masking stays inside strings: the line is still JSON of the same shape.
    assert.equal(log.at, Number(secret))
  })

  test("a failed prepare keeps the failure's message, not its full log", async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail })
    const target = { kind: 'docker', key: 'k', label: 'docker', setBy: ['config'], runWide: true }
    const failure = {
      class: 'infra' as const,
      stage: 'install',
      ref: null,
      cause: null,
      log: 'every line docker printed',
      message: 'install failed',
    }
    stream.write({
      type: 'prepare',
      at: 1,
      state: 'failed',
      outcome: { ok: false, ms: 5, target, failure },
    } as never)
    await stream.end(0)
    const line = readLines(file)[1] as Extract<RunEventLine, { type: 'prepare' }>
    assert.ok(line.state !== 'start' && !line.outcome.ok)
    assert.deepEqual(line.outcome.failure, { ...failure, log: null })
  })

  test("won't write over a file that isn't an event stream", async () => {
    const dir = tempDir('events')
    const file = join(dir, 'x.eval.ts')
    writeFileSync(file, 'evaluate()\n')
    const warnings: string[] = []
    const stream = openEventStream({ file, header: header(), warn: (w) => warnings.push(w) })
    stream.write(notice('a'))
    await stream.end(0)
    assert.equal(readFileSync(file, 'utf8'), 'evaluate()\n')
    assert.match(warnings.join('\n'), /x\.eval\.ts isn't a reeval event stream/)
    const appended = openEventStream({
      file,
      append: true,
      header: header(),
      warn: (w) => warnings.push(w),
    })
    await appended.end(0)
    assert.equal(readFileSync(file, 'utf8'), 'evaluate()\n')
  })

  test("a posting failure's warning names the URL without its credentials or secrets", async () => {
    const warnings: string[] = []
    const key = `sk-ant-${'b'.repeat(40)}`
    const stream = openEventStream({
      url: 'https://user:hunter2@relay.test/events',
      header: header(),
      warn: (w) => warnings.push(w),
      fetch: async () => {
        throw new Error(`refused with ${key}`)
      },
    })
    await stream.end(0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /to https:\/\/relay\.test\/events: refused with/)
    assert.ok(!warnings[0]?.includes('hunter2'))
    assert.ok(!warnings[0]?.includes(key))
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

  test('a line the server refuses as too large (413) says so, with its message and no token', async () => {
    const warnings: string[] = []
    const stream = openEventStream({
      url: 'https://relay.test/api/runs/r1/events?token=hunter2',
      header: header(),
      warn: (w) => warnings.push(w),
      fetch: async () =>
        Response.json(
          {
            error: { code: 'payload_too_large', message: 'line 2 is too large', retryable: false },
          },
          { status: 413 },
        ),
    })
    await stream.end(0)
    assert.deepEqual(warnings, [
      'stopped posting the event stream to https://relay.test/api/runs/r1/events?token=***: HTTP 413: the server refused a batch as too large, likely a line over its size limit (line 2 is too large)',
    ])
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

  test('a file cut short while it follows is an error, not a hang', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail })
    stream.write(notice('before'))
    const done = attach({
      source: file,
      out: capture(),
      output: () => output,
      follow: { pollMs: 10, alive: () => true },
    })
    await sleep(50)
    truncateSync(file, 0)
    await assert.rejects(
      done,
      (error: Error) =>
        error instanceof EventStreamError && /a\.ndjson was cut short/.test(error.message),
    )
    await stream.end(0)
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

  test("the paths a run printed from its own directory read as the project's, or from the viewer's", async () => {
    const runHeader = (config: string, record: string): RunHeader => ({
      version: '0.1.0',
      runId: 'run-1',
      dryRun: false,
      config,
      record,
      harnesses: ['fake'],
      sandboxes: ['fake'],
      judges: [],
      files: 1,
      evals: 1,
      skipped: 0,
      cells: 1,
      attempts: 1,
      fewest: 1,
      budget: {},
      estimateMs: 0,
      concurrency: 1,
    })
    /** A run's plan, failed prepare and end, its paths printed from `up` (where its root is). */
    const printed = (up: string, history = `${up}/.reeval/runs`) => {
      const config = `${up}/reeval.config.ts`
      const target = {
        kind: 'image',
        key: 'k',
        label: 'reeval-sandbox:fake',
        setBy: [config, 'evals/a.eval.ts'],
        runWide: true,
      } as const
      return {
        config,
        events: [
          {
            type: 'plan',
            at: 1,
            line: `plan  run run-1 · config ${config} · 1 eval`,
            header: runHeader(config, `${history}/run-1.json`),
            details: [],
            warnings: [],
            hints: [],
          },
          {
            type: 'prepare',
            at: 1,
            state: 'failed',
            outcome: { target, ok: false, failure: { message: 'no image', log: null }, ms: 1 },
          },
          {
            type: 'run-end',
            at: 1,
            summaryPath: `${history}/run-1/summary.md`,
            recorded: {
              record: `${up}/evals/.history/run-1.json`,
              files: `${up}/evals/.history/run-1`,
              archive: `${up}/evals/.history/run-1.zip`,
            },
          },
        ] as ReevalEvent[],
      }
    }
    const shown = (
      run: ReturnType<typeof printed>,
      cwd: string | undefined,
      root?: string,
    ): Record<string, unknown> => {
      const path = viewerPath(
        {
          type: 'header',
          schemaVersion: 1,
          pid: 1,
          host: 'runner',
          ...header(),
          ...(cwd === undefined ? {} : { cwd }),
        },
        root,
      )
      const [p, f, e] = run.events.map((event) => viewerEvent(event, path, run.config))
      return {
        line: p?.type === 'plan' && p.line,
        config: p?.type === 'plan' && p.header.config,
        record: p?.type === 'plan' && p.header.record,
        setBy: f?.type === 'prepare' && f.state !== 'start' && f.outcome.target.setBy,
        summary: e?.type === 'run-end' && e.summaryPath,
      }
    }
    const recorded = (run: ReturnType<typeof printed>, cwd: string) => {
      const path = viewerPath(
        { type: 'header', schemaVersion: 1, pid: 1, host: 'h', ...header(), cwd },
        undefined,
      )
      const end = viewerEvent(run.events[2] as ReevalEvent, path, run.config)
      return end.type === 'run-end' ? end.recorded : undefined
    }
    // A run in evals/: without a project of its own, the viewer reads its paths from the project
    // root, where the config is, so the plan doesn't name it, as a run there wouldn't.
    const inEvals = printed('..')
    assert.deepEqual(recorded(inEvals, 'evals'), {
      record: 'evals/.history/run-1.json',
      files: 'evals/.history/run-1',
      archive: 'evals/.history/run-1.zip',
    })
    assert.deepEqual(shown(inEvals, 'evals'), {
      line: 'plan  run run-1 · 1 eval',
      config: undefined,
      record: '.reeval/runs/run-1.json',
      setBy: ['reeval.config.ts', 'evals/a.eval.ts'],
      summary: '.reeval/runs/run-1/summary.md',
    })
    // In the project, from a directory below its root, they're from there, as reeval run's would be.
    const mine = tempDir('viewer')
    mkdirSync(join(mine, 'sub'))
    const cwd = process.cwd()
    process.chdir(join(mine, 'sub'))
    try {
      assert.deepEqual(shown(inEvals, 'evals', mine), {
        line: 'plan  run run-1 · config ../reeval.config.ts · 1 eval',
        config: '../reeval.config.ts',
        record: '../.reeval/runs/run-1.json',
        setBy: ['../reeval.config.ts', 'evals/a.eval.ts'],
        summary: '../.reeval/runs/run-1/summary.md',
      })
    } finally {
      process.chdir(cwd)
    }
    // A history folder inside the directory the run ran in is under that directory.
    const inSub = printed('..', '.history')
    assert.equal(shown(inSub, 'sub').record, 'sub/.history/run-1.json')
    assert.equal(shown(inSub, 'sub').summary, 'sub/.history/run-1/summary.md')
    // A run in its root prints them as the project's already.
    const inRoot = printed('.')
    assert.equal(shown(inRoot, '').summary, '.reeval/runs/run-1/summary.md')
    assert.equal(shown(inRoot, '').line, 'plan  run run-1 · 1 eval')
    // From outside the project they climb out of it and back in through its own folder.
    const outside = printed('../proj')
    assert.equal(shown(outside, '../away').summary, '../proj/.reeval/runs/run-1/summary.md')
    // An older reeval's stream says nothing of its directory, so its paths stay as it printed them.
    assert.deepEqual(shown(inEvals, undefined), {
      line: 'plan  run run-1 · config ../reeval.config.ts · 1 eval',
      config: '../reeval.config.ts',
      record: '../.reeval/runs/run-1.json',
      setBy: ['../reeval.config.ts', 'evals/a.eval.ts'],
      summary: '../.reeval/runs/run-1/summary.md',
    })
  })

  test("a line that isn't JSON is refused", async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    writeFileSync(file, 'not json\n')
    await assert.rejects(
      attach({ source: file, out: capture(), output: () => output }),
      /has a line that isn't JSON: not json/,
    )
  })

  test('posts to a URL and follows it over a WebSocket there, replaying then live', async () => {
    const r = await relay()
    try {
      const stream = openEventStream({ url: r.url, header: header(), warn: assert.fail })
      stream.write(notice('over http'))
      await waitFor(() => r.lines.length >= 2)
      const out = capture()
      const done = attach({ source: r.url, out, output: () => output })
      await waitFor(() => r.afters.length === 1)
      stream.write(notice('then more'))
      await stream.end(1)
      assert.equal(await done, 1)
      assert.match(out.text, /over http[\s\S]*then more/)
      assert.deepEqual(r.afters, ['0'])
    } finally {
      await r.close()
    }
  })

  test('a dropped socket reconnects after the last line it got, and draws each line once', async () => {
    const r = await relay()
    try {
      const stream = openEventStream({
        url: r.url,
        header: header(),
        warn: assert.fail,
        heartbeatMs: 0,
      })
      stream.write(notice('before the drop'))
      await waitFor(() => r.lines.length >= 2)
      const out = capture()
      const done = attach({ source: r.url, out, output: () => output })
      await waitFor(() => r.sent >= 2)
      r.drop()
      await waitFor(() => r.afters.length === 2)
      stream.write(notice('after the drop'))
      await stream.end(0)
      assert.equal(await done, 0)
      assert.deepEqual(r.afters, ['0', '2'])
      assert.equal(out.text.match(/before the drop/g)?.length, 1)
      assert.match(out.text, /Lost the connection to run run-1; reconnecting[\s\S]*after the drop/)
    } finally {
      await r.close()
    }
  })

  test('a viewer past the run’s limit is refused with a clear error', async () => {
    const r = await relay({ maxViewers: 1 })
    try {
      const stream = openEventStream({ url: r.url, header: header(), warn: assert.fail })
      await waitFor(() => r.lines.length >= 1)
      const first = attach({ source: r.url, out: capture(), output: () => output })
      await waitFor(() => r.afters.length === 1)
      await assert.rejects(
        attach({ source: r.url, out: capture(), output: () => output }),
        (error: Error) =>
          error instanceof EventStreamError &&
          /has as many viewers as it takes \(1 viewers per run\): detach one and attach again/.test(
            error.message,
          ),
      )
      await stream.end(0)
      assert.equal(await first, 0)
    } finally {
      await r.close()
    }
  })

  test("a socket that closes before the exit line, or that can't connect, is an error", async () => {
    const r = await relay({ closeAtOnce: true })
    try {
      const stream = openEventStream({ url: r.url, header: header(), warn: assert.fail })
      await waitFor(() => r.lines.length >= 1)
      await assert.rejects(
        attach({ source: r.url, out: capture(), output: () => output }),
        /the event stream at http:\/\/127\.0\.0\.1:\d+\/events ended before the run did/,
      )
      await stream.end(0)
    } finally {
      await r.close()
    }
    await assert.rejects(
      attach({ source: 'ws://127.0.0.1:9/events', out: capture(), output: () => output }),
      /can't connect to the event stream at ws:\/\/127\.0\.0\.1:9\/events/,
    )
  })

  test('a socket that stays down past the reconnect window gives up', async () => {
    const r = await relay()
    try {
      const stream = openEventStream({ url: r.url, header: header(), warn: assert.fail })
      await waitFor(() => r.lines.length >= 1)
      const done = attach({
        source: r.url,
        out: capture(),
        output: () => output,
        follow: { reconnectMs: 300 },
      })
      await waitFor(() => r.sent >= 1)
      r.refuseUpgrades()
      r.drop()
      await assert.rejects(
        done,
        /lost the connection to http:\/\/127\.0\.0\.1:\d+\/events and couldn't reconnect/,
      )
      await stream.end(0)
    } finally {
      await r.close()
    }
  })

  /** A WebSocket server that answers each connection with `serve`, and the source to attach to. */
  const scripted = async (serve: (ws: WebSocket, after: string) => void) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => server.once('listening', resolve))
    server.on('connection', (ws, req) =>
      serve(ws, new URL(req.url ?? '', 'ws://x').searchParams.get('after') ?? ''),
    )
    return {
      source: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
      close: () => new Promise((resolve) => server.close(resolve)),
    }
  }
  const frame = (seq: number, line: object) => JSON.stringify({ seq, line })
  const headerLine = { type: 'header', schemaVersion: 1, ...header(), pid: 1, host: 'elsewhere' }

  test('a refusing close code fails at once, naming why', async () => {
    for (const [code, message] of [
      [4401, /refused the token \(bad token\)/],
      [4403, /refused this viewer \(bad token\)/],
      [4404, /there's no run at .* \(bad token\)/],
      [4000, /closed with 4000 \(bad token\)/],
      [1008, /closed with 1008 \(bad token\)/],
    ] as const) {
      let connections = 0
      const s = await scripted((ws) => {
        connections++
        ws.close(code, 'bad token')
      })
      try {
        await assert.rejects(
          attach({ source: s.source, out: capture(), output: () => output }),
          (error: Error) => error instanceof EventStreamError && message.test(error.message),
        )
        assert.equal(connections, 1, `${code} isn't reconnected after`)
      } finally {
        await s.close()
      }
    }
  })

  test('replayed lines it already drew are dropped, and a gap is an error', async () => {
    let connections = 0
    const replays = await scripted((ws) => {
      connections++
      // Ignores `after`, so the reconnect replays from the start.
      ws.send(frame(1, headerLine))
      ws.send(frame(2, notice('once')))
      if (connections === 1) return void ws.terminate()
      ws.send(frame(3, { type: 'exit', at: 3, code: 7 }))
      ws.close(1000)
    })
    try {
      const out = capture()
      assert.equal(await attach({ source: replays.source, out, output: () => output }), 7)
      assert.equal(out.text.match(/once/g)?.length, 1)
    } finally {
      await replays.close()
    }
    const gap = await scripted((ws) => {
      ws.send(frame(1, headerLine))
      ws.send(frame(3, notice('late')))
    })
    try {
      await assert.rejects(
        attach({ source: gap.source, out: capture(), output: () => output }),
        /skipped from line 1 to line 3/,
      )
    } finally {
      await gap.close()
    }
  })

  test("a resume's lines follow the run's exit line over the socket: it draws both and exits with the last code", async () => {
    const r = await relay({ resumes: true })
    try {
      const first = openEventStream({ url: r.url, header: header(), warn: assert.fail })
      first.write(notice('first part'))
      await first.end(130)
      await waitFor(() => r.lines.length >= 3)
      const out = capture()
      let code: number | undefined
      const done = attach({ source: r.url, out, output: () => output }).then((c) => (code = c))
      await waitFor(() => r.sent >= 3)
      await sleep(50)
      assert.equal(code, undefined, 'an exit line alone does not end attach')
      const resume = openEventStream({ url: r.url, header: header(), warn: assert.fail })
      resume.write(notice('second part'))
      await resume.end(0)
      await waitFor(() => r.sent >= 6)
      r.finish()
      await done
      assert.equal(code, 0)
      assert.match(out.text, /first part[\s\S]*second part/)
    } finally {
      await r.close()
    }
  })

  test('a server that accepts then drops is retried with a growing wait, and each open restarts the give-up window', async () => {
    const opens: number[] = []
    const s = await scripted((ws) => {
      opens.push(Date.now())
      if (opens.length <= 3) return void ws.terminate()
      ws.send(frame(1, headerLine))
      ws.send(frame(2, { type: 'exit', at: 2, code: 7 }))
      ws.close(1000)
    })
    try {
      const out = capture()
      const code = await attach({
        source: s.source,
        out,
        output: () => output,
        // Shorter than the waits added up, so only a reset on each open keeps it reconnecting.
        follow: { reconnectMs: 600 },
      })
      assert.equal(code, 7)
      const [a = 0, b = 0, c = 0] = opens.slice(1).map((at, i) => at - (opens[i] ?? at))
      assert.ok(a >= 200 && b >= 450 && c >= 900, `waits ${a}, ${b}, ${c}`)
    } finally {
      await s.close()
    }
  })

  test("a token in the URL's query is masked in the error", async () => {
    const s = await scripted((ws) => ws.close(4401, 'expired'))
    try {
      await assert.rejects(
        attach({ source: `${s.source}?token=hunter2`, out: capture(), output: () => output }),
        (error: Error) =>
          /\/events\?token=\*\*\* refused the token \(expired\)/.test(error.message) &&
          !error.message.includes('hunter2'),
      )
    } finally {
      await s.close()
    }
  })

  test('a connected viewer sends "ping" and ignores the "pong" answers', async () => {
    const got: string[] = []
    const s = await scripted((ws) => {
      ws.on('message', (data) => {
        got.push(String(data))
        ws.send('pong')
        if (got.length < 2) return
        ws.send(frame(1, headerLine))
        ws.send('pong')
        ws.send(frame(2, { type: 'exit', at: 2, code: 7 }))
        ws.close(1000)
      })
    })
    try {
      const code = await attach({
        source: s.source,
        out: capture(),
        output: () => output,
        follow: { pingMs: 20 },
      })
      assert.equal(code, 7)
      assert.deepEqual(got.slice(0, 2), ['ping', 'ping'])
    } finally {
      await s.close()
    }
  })

  test('a viewer evicted as stale (1001) reconnects after the last line it got', async () => {
    const afters: string[] = []
    const s = await scripted((ws, after) => {
      afters.push(after)
      if (afters.length === 1) {
        ws.send(frame(1, headerLine))
        return void ws.close(1001, 'stale viewer')
      }
      ws.send(frame(2, { type: 'exit', at: 2, code: 7 }))
      ws.close(1000)
    })
    try {
      const out = capture()
      assert.equal(await attach({ source: s.source, out, output: () => output }), 7)
      assert.deepEqual(afters, ['0', '1'])
      assert.match(out.text, /Lost the connection to run run-1; reconnecting/)
    } finally {
      await s.close()
    }
  })

  test('a frame without a seq and line is an error', async () => {
    for (const data of ['null', '{"seq":1}', '[1]', 'nope']) {
      const s = await scripted((ws) => ws.send(data))
      try {
        await assert.rejects(
          attach({ source: s.source, out: capture(), output: () => output }),
          (error: Error) =>
            error instanceof EventStreamError &&
            /sent a frame (without a seq and line|that isn't JSON)/.test(error.message),
        )
      } finally {
        await s.close()
      }
    }
  })
})

describe('heartbeats', () => {
  /** Until `ready()`, checked every few milliseconds, for at most 10s. */
  const until = async (ready: () => boolean) => {
    for (const deadline = Date.now() + 10_000; !ready(); await sleep(5)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${ready}`)
    }
  }
  const beats = (file: string) => readLines(file).filter((l) => l.type === 'heartbeat').length
  /** A stream from a run on another host, which attach can't check for a live process. */
  const remote = (file: string, ...lines: object[]) =>
    appendFileSync(
      file,
      [{ type: 'header', schemaVersion: 1, ...header(), pid: 1, host: 'build-7' }, ...lines]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join(''),
    )
  /** The same, from a run whose header says it writes heartbeats. */
  const beating = (file: string, ...lines: object[]) =>
    appendFileSync(
      file,
      [
        {
          type: 'header',
          schemaVersion: 1,
          ...header(),
          pid: 1,
          host: 'build-7',
          heartbeatMs: 5000,
        },
        ...lines,
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join(''),
    )
  const heartbeat = { type: 'heartbeat', at: 1 }

  test('the header names the interval; a quiet stream gets heartbeat lines, a busy one none, and none comes after the exit line', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail, heartbeatMs: 20 })
    assert.equal((readLines(file)[0] as RunEventsHeader).heartbeatMs, 20)
    await until(() => beats(file) >= 2)
    await stream.end(0)
    const lines = readLines(file)
    assert.equal(lines.at(-1)?.type, 'exit')
    await sleep(60)
    assert.deepEqual(readLines(file), lines)

    const busy = join(tempDir('events'), 'b.ndjson')
    const chatty = openEventStream({
      file: busy,
      header: header(),
      warn: assert.fail,
      heartbeatMs: 300,
    })
    for (let i = 0; i < 40; i++, await sleep(10)) chatty.write(notice(`line ${i}`))
    await chatty.end(0)
    assert.equal(beats(busy), 0)
    assert.equal((readLines(busy)[0] as RunEventsHeader).heartbeatMs, 300, 'so a stall still shows')

    const none = join(tempDir('events'), 'c.ndjson')
    const off = openEventStream({ file: none, header: header(), warn: assert.fail, heartbeatMs: 0 })
    await sleep(60)
    await off.end(0)
    assert.deepEqual(
      readLines(none).map((l) => l.type),
      ['header', 'exit'],
    )
    assert.equal('heartbeatMs' in (readLines(none)[0] as RunEventsHeader), false)
  })

  test('a heartbeat with the attempts in progress is written as given, and none after the exit line', async () => {
    const file = join(tempDir('events'), 'attempts.ndjson')
    const stream = openEventStream({ file, header: header(), warn: assert.fail, heartbeatMs: 0 })
    stream.heartbeat(['evals/a.eval.ts › one # fake/-/fake#1'])
    stream.heartbeat([])
    await stream.end(0)
    stream.heartbeat(['late'])
    const lines = readLines(file)
    assert.deepEqual(
      lines.map((l) => (l.type === 'heartbeat' ? l.attempts : l.type)),
      ['header', ['evals/a.eval.ts › one # fake/-/fake#1'], [], 'exit'],
    )
  })

  test('a URL sink gets the heartbeats too', async () => {
    const bodies: string[] = []
    const stream = openEventStream({
      url: 'https://relay.test/events',
      header: header(),
      warn: assert.fail,
      heartbeatMs: 20,
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response(null, { status: 204 })
      },
    })
    await until(() => bodies.join('').includes('"type":"heartbeat"'))
    await stream.end(0)
    const lines = bodies
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RunEventLine)
    assert.equal(lines[0]?.type, 'header')
    assert.equal(lines.at(-1)?.type, 'exit')
  })

  for (const mode of ['plain', 'agent'] as const) {
    test(`attach says a run that stopped beating may have stalled, then that it is back (${mode})`, async () => {
      const file = join(tempDir('events'), 'a.ndjson')
      remote(file, notice('working'), heartbeat)
      const out = capture()
      const done = attach({
        source: file,
        out,
        output: () => ({ ...output, mode }),
        follow: { pollMs: 10 },
        silence: { stallMs: 50, lostMs: 60_000 },
      })
      await until(() => out.text.includes('No word'))
      assert.match(
        out.text,
        /⚠ {2}No word from run run-1 for 50ms: it may have stalled, or lost its connection\./,
      )
      appendFileSync(file, `${JSON.stringify(notice('still here'))}\n`)
      appendFileSync(file, `${JSON.stringify({ type: 'exit', at: 2, code: 0 })}\n`)
      assert.equal(await done, 0)
      assert.match(out.text, /No word[\s\S]*Run run-1 is sending again\.[\s\S]*still here/)
    })
  }

  test('attach says a busy run that stalled before any heartbeat may have stalled, from its header on', async () => {
    const busy = join(tempDir('events'), 'a.ndjson')
    beating(busy, notice('one'), notice('two'), notice('three'))
    const resumed = join(tempDir('events'), 'b.ndjson')
    beating(resumed, notice('first part'), { type: 'exit', at: 2, code: 130 })
    beating(resumed)
    for (const source of [busy, resumed]) {
      const out = capture()
      const done = attach({
        source,
        out,
        output: () => output,
        follow: { pollMs: 10 },
        silence: { stallMs: 50, lostMs: 150 },
      })
      await until(() => out.text.includes('No word'))
      assert.match(out.text, /No word from run run-1 for 50ms/)
      await assert.rejects(done, /stopped following it as lost/)
    }
  })

  test('attach gives up on a run quiet for long enough, as lost', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    remote(file, heartbeat)
    const out = capture()
    await assert.rejects(
      attach({
        source: file,
        out,
        output: () => output,
        follow: { pollMs: 10 },
        silence: { stallMs: 30, lostMs: 100 },
      }),
      (error: Error) =>
        error instanceof EventStreamError &&
        /no word from run run-1 for 100ms and no exit line: reeval attach stopped following it as lost/.test(
          error.message,
        ),
    )
    assert.match(out.text, /No word from run run-1 for 30ms/)
  })

  test('a stream without heartbeats, or a resume that writes none, is never called stalled', async () => {
    const file = join(tempDir('events'), 'a.ndjson')
    remote(file, notice('an older reeval'))
    const resumed = join(tempDir('events'), 'b.ndjson')
    remote(resumed, heartbeat, { type: 'exit', at: 2, code: 130 })
    remote(resumed, notice('resumed by an older reeval'))
    for (const source of [file, resumed]) {
      const out = capture()
      await assert.rejects(
        attach({
          source,
          out,
          output: () => output,
          follow: { pollMs: 10, signal: AbortSignal.timeout(200) },
          silence: { stallMs: 10, lostMs: 30 },
        }),
        /ended before the run did/,
      )
      assert.match(out.text, /older reeval/)
      assert.doesNotMatch(out.text, /No word/)
    }
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

  test("a run's paths from a folder in its project print as they did, and attach reads them as the project's", async () => {
    const p = await project('events-paths', {
      'reeval.config.ts': config,
      'evals/passes.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('passes', async (c) => {
  expect(c.attempt.n).toBe(1)
})
`,
    })
    const away = tempDir('events-away')
    const stream = join(away, 'run.ndjson')
    const ran = await runCli(join(p.dir, 'evals'), ['run', '--events-file', stream])
    assert.equal(ran.code, 0, ran.stderr)
    assert.match(ran.stdout, /Config: +\.\.\/reeval\.config\.ts/)
    assert.match(ran.stdout, /Record: +\.\.\/\.reeval\/runs\//)
    assert.match(ran.stdout, /summary \.\.\/\.reeval\/runs\/\S+\/summary\.md/)
    assert.equal((readLines(stream)[0] as RunEventsHeader).cwd, 'evals')
    // Outside any project, the paths are the project's, as a run in its root prints them.
    const viewed = await runCli(away, ['attach', stream])
    assert.equal(viewed.code, 0, viewed.stderr)
    assert.match(viewed.stdout, /Record: +\.reeval\/runs\//)
    assert.match(viewed.stdout, /summary \.reeval\/runs\/\S+\/summary\.md/)
    assert.doesNotMatch(viewed.stdout, /Config:|\.\.\//)
    // In the project, from a directory below its root, they're from there.
    mkdirSync(join(p.dir, 'evals', 'deeper'))
    const below = await runCli(join(p.dir, 'evals', 'deeper'), [
      'attach',
      stream,
      '--config',
      '../../reeval.config.ts',
    ])
    assert.equal(below.code, 0, below.stderr)
    assert.match(below.stdout, /Config: +\.\.\/\.\.\/reeval\.config\.ts/)
    assert.match(below.stdout, /summary \.\.\/\.\.\/\.reeval\/runs\/\S+\/summary\.md/)
  })

  test('an attempt reports its sandbox up before its setup steps run, and ready after', async () => {
    const p = await project('events-sandbox-up', {
      'reeval.config.ts': config,
      'evals/slow.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const slow = defineEnvironment('slow', { setup: [{ run: 'sleep 1 && touch set-up' }] })
evaluate('slow', { environments: slow }, async (c) => {
  expect(await c.readFile('set-up')).toBe('')
})
`,
    })
    const stream = join(tempDir('events-sandbox-up'), 'run.ndjson')
    const ran = await runCli(p.dir, ['run', '--events-file', stream])
    assert.equal(ran.code, 0, ran.stderr)
    const progress = readLines(stream).flatMap((l) =>
      l.type === 'eval-progress' ? [l.progress] : [],
    )
    const kinds = progress.map((u) => u.kind).filter((k) => k.startsWith('sandbox'))
    assert.deepEqual(kinds, ['sandbox', 'sandbox-up', 'sandbox-ready'])
    const at = (kind: string) => progress.find((u) => u.kind === kind)?.at ?? Number.NaN
    assert.ok(at('sandbox-ready') - at('sandbox-up') >= 1000, 'the setup step runs in between')
  })

  test('a heartbeat names the attempts in progress on REEVAL_EVENTS_HEARTBEAT, stops with the run, and draws nothing', async () => {
    const p = await project('events-attempts-heartbeat', {
      'reeval.config.ts': config,
      'evals/both.eval.ts': `import { evaluate, expect } from 'reeval'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
evaluate('quick', async (c) => {
  await wait(600)
  expect(c.attempt.n).toBe(1)
})
evaluate('slow', async (c) => {
  await wait(1800)
  expect(c.attempt.n).toBe(1)
})
`,
    })
    const stream = join(tempDir('events-attempts-heartbeat'), 'run.ndjson')
    const ran = await runCli(p.dir, ['run', '--events-file', stream], {
      env: { REEVAL_EVENTS_HEARTBEAT: '100ms' },
    })
    assert.equal(ran.code, 0, ran.stderr)
    const lines = readLines(stream)
    const beats = lines.flatMap((l, i) =>
      l.type === 'heartbeat' && l.attempts ? [{ i, names: l.attempts.map(nameOf) }] : [],
    )
    const states = beats
      .map((b) => b.names.join(','))
      .filter((s, i, all) => s !== all[i - 1] && s !== '')
    assert.deepEqual(states, ['quick,slow', 'slow'])
    const end = lines.findIndex((l) => l.type === 'run-end')
    assert.ok(end > 0 && beats.every((b) => b.i < end), 'none after the run ends')
    const { dir } = readRun(p.dir)
    for (const file of [`${dir}.json`, ...readdirSync(dir, { recursive: true }).map(String)]) {
      const path = file.startsWith(dir) ? file : join(dir, file)
      if (statSync(path).isFile())
        assert.doesNotMatch(readFileSync(path, 'utf8'), /"type":"heartbeat"/, file)
    }
    const attached = await runCli(p.dir, ['attach', stream])
    assert.equal(attached.code, 0, attached.stderr)
    assert.equal(attached.stdout, ran.stdout)

    const refused = await runCli(p.dir, ['run', '--events-file', stream], {
      env: { REEVAL_EVENTS_HEARTBEAT: 'often' },
    })
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /REEVAL_EVENTS_HEARTBEAT must be a duration like 30s/)
  })

  test("run-end names the record, files and archive --record wrote; an unrecorded run's names none", async () => {
    const p = await project('events-recorded', {
      'reeval.config.ts': config.replace(
        'sandbox: fakeSandbox() }',
        'sandbox: fakeSandbox(), history: { archive: true } }',
      ),
      'evals/passes.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('passes', async (c) => {
  expect(c.attempt.n).toBe(1)
})
`,
    })
    const evals = join(p.dir, 'evals')
    const stream = join(p.dir, 'recorded.ndjson')
    const ran = await runCli(evals, ['run', '--record', '--events-file', stream])
    assert.equal(ran.code, 0, ran.stderr)
    const lines = readLines(stream)
    const id = (lines[0] as RunEventsHeader).runId
    const end = lines.find((l) => l.type === 'run-end')
    assert.ok(end?.type === 'run-end')
    assert.deepEqual(end.recorded, {
      record: `.history/${id}.json`,
      files: `.history/${id}`,
      archive: `.history/${id}.zip`,
    })
    assert.ok(existsSync(join(evals, end.recorded.record)))
    assert.ok(existsSync(join(evals, end.recorded.files as string, 'summary.md')))
    assert.ok(existsSync(join(evals, end.recorded.archive as string)))
    // The record line still follows the run's summary.
    const summary = ran.stdout.search(/summary \.\.\/\.reeval\/runs\//)
    assert.ok(summary >= 0 && summary < ran.stdout.search(/recorded \.history\//), ran.stdout)

    const unrecorded = join(p.dir, 'unrecorded.ndjson')
    assert.equal((await runCli(evals, ['run', '--events-file', unrecorded])).code, 0)
    const plain = readLines(unrecorded).find((l) => l.type === 'run-end')
    assert.ok(plain?.type === 'run-end')
    assert.equal(plain.recorded, undefined)
  })

  test('a quiet run writes heartbeats to its stream, which attach replays as the run printed', async () => {
    const p = await project('events-heartbeat', {
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
    const events = join(p.dir, '.reeval', 'events')
    const beat = () =>
      existsSync(events) &&
      readdirSync(events).some((n) =>
        readFileSync(join(events, n), 'utf8').includes('"type":"heartbeat"'),
      )
    try {
      for (let i = 0; i < 300 && !beat(); i++) await sleep(50)
      assert.ok(beat(), 'a heartbeat within 15s')
      const [stream] = readdirSync(events)
      assert.equal(
        (readLines(join(events, stream as string))[0] as RunEventsHeader).heartbeatMs,
        5000,
      )
      writeFileSync(join(p.dir, 'go'), '')
      assert.equal(await exited, 0)
    } finally {
      run.kill()
    }
    const attached = await runCli(p.dir, ['attach', /Run: +(\S+)/.exec(ran)?.[1] ?? ''])
    assert.equal(attached.code, 0, attached.stderr)
    assert.equal(attached.stdout, ran)
  })

  test('a resume appends to the stream the run started, without --events', {
    skip: noSignals,
  }, async () => {
    const p = await project('events-resume', {
      'reeval.config.ts': config,
      'evals/waits.eval.ts': gated,
    })
    const file = join(p.dir, 'out', 'events.ndjson')
    const stopped = await runCli(p.dir, ['run', '--events-file', 'out/events.ndjson'], {
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

  test("attach's cancel signal is a first Ctrl-C only: never the second that quits without a record", {
    skip: noSignals,
  }, async () => {
    for (const signals of [
      ['SIGINT', 'SIGUSR2', 'SIGUSR2'],
      ['SIGUSR2', 'SIGUSR2'],
    ] as const) {
      const p = await project('events-cancel', {
        'reeval.config.ts': config,
        'evals/waits.eval.ts': gated,
      })
      const stopped = await runCli(p.dir, ['run'], {
        onOutput: (stdout, pid) => {
          if (!stdout.includes('Running')) return false
          for (const signal of signals) process.kill(pid, signal)
          return true
        },
      })
      assert.equal(stopped.code, 130, `${signals}: ${stopped.stderr}`)
      assert.doesNotMatch(stopped.stderr, /discards the run/, `${signals}`)
      assert.equal(readRun(p.dir).run.status, 'interrupted', `${signals}`)
    }
  })

  /** One eval that ignores the cancel, so a signal can land while the run is still canceling. */
  const slow = `import { setTimeout as sleep } from 'node:timers/promises'
import { evaluate } from 'reeval'
evaluate('slow', async (c) => {
  await c.send('write hello.txt')
  console.log('parked')
  await sleep(8_000)
})
`

  test("a Ctrl-C the run sees just after attach's cancel is the same press: the run is recorded", {
    skip: noSignals,
  }, async () => {
    // Linux delivers a pending SIGINT before a SIGUSR2, so the Ctrl-C waits for the cancel's
    // notice to reach the run after it.
    const p = await project('events-cancel-then-ctrl-c', {
      'reeval.config.ts': config,
      'evals/slow.eval.ts': slow,
    })
    let canceled = false
    const stopped = await runCli(p.dir, ['run', '--output-logs', 'full'], {
      onOutput: (stdout, pid) => {
        if (!canceled && /parked/.test(stdout)) {
          canceled = true
          process.kill(pid, 'SIGUSR2')
        }
        if (!stdout.includes('Canceling:')) return false
        process.kill(pid, 'SIGINT')
        return true
      },
    })
    assert.equal(stopped.code, 130, stopped.stdout + stopped.stderr)
    assert.doesNotMatch(stopped.stderr, /discards the run/)
    assert.equal(readRun(p.dir).run.status, 'interrupted')
  })

  test("a Ctrl-C a while after attach's cancel is the second press, which quits without a record", {
    skip: noSignals,
  }, async () => {
    const p = await project('events-cancel-later', {
      'reeval.config.ts': config,
      'evals/slow.eval.ts': slow,
    })
    const stopped = await runCli(p.dir, ['run', '--output-logs', 'full'], {
      onOutput: (stdout, pid) => {
        if (!/parked/.test(stdout)) return false
        process.kill(pid, 'SIGUSR2')
        setTimeout(() => process.kill(pid, 'SIGINT'), 2_500)
        return true
      },
    })
    assert.equal(stopped.code, 130, stopped.stdout + stopped.stderr)
    assert.match(stopped.stdout, /Ctrl-C again quits at once, without a record/)
    assert.match(stopped.stderr, /quit without writing run \S+'s record/)
  })

  const pty =
    process.platform === 'linux' && spawnSync('script', ['--version']).status === 0
      ? false
      : "needs util-linux's script to give reeval attach a terminal"
  test('on a terminal, reeval attach draws the list, and x twice cancels the run, which writes its record', {
    skip: pty || noSignals,
  }, async () => {
    const p = await project('events-tty', {
      'reeval.config.ts': config,
      'evals/waits.eval.ts': gated,
    })
    const running = runCli(p.dir, ['run', '--events'], {
      onOutput: (stdout) => stdout.includes('Running'),
    })
    const staging = join(p.dir, '.reeval', 'staging')
    const live = () =>
      existsSync(staging) &&
      readdirSync(staging).some((id) => existsSync(join(staging, id, 'live.json')))
    for (let i = 0; i < 400 && !live(); i++) await sleep(25)
    const { REEVAL_UI: _, ...env } = baseEnv
    const viewer = spawn(
      'script',
      ['-qec', `'${process.execPath}' '${join(pkgRoot, 'dist/cli.js')}' attach`, '/dev/null'],
      { cwd: p.dir, env: { ...env, TERM: 'xterm-256color' } },
    )
    let shown = ''
    viewer.stdout.on('data', (d) => (shown += d))
    const viewed = new Promise<number | null>((resolve) => viewer.on('close', resolve))
    const shows = async (text: string) => {
      for (let i = 0; i < 400 && !stripAnsi(shown).includes(text); i++) await sleep(25)
      assert.ok(stripAnsi(shown).includes(text), `${text} in:\n${stripAnsi(shown)}`)
    }
    try {
      await shows('q detach · x cancel the run')
      viewer.stdin.write('x')
      await shows('Press x again to cancel the run.')
      viewer.stdin.write('x')
      // The eval's body doesn't watch for the cancel, so the run waits for it to end.
      await shows('Canceling')
      writeFileSync(join(p.dir, 'go'), '')
      const ran = await running
      assert.equal(ran.code, 130, ran.stderr)
      assert.equal(readRun(p.dir).run.status, 'interrupted')
      await shows('q quit')
      viewer.stdin.write('q')
      assert.equal(await viewed, 130, "attach exits with the run's code")
    } finally {
      viewer.kill()
    }
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
    const userinfo = await runCli(p.dir, ['run', '--events-url', 'https://u:hunter2@relay.test/e'])
    assert.equal(userinfo.code, 2)
    assert.match(
      userinfo.stderr,
      /--events-url can't carry a user name or password \(got https:\/\/relay\.test\/e\)/,
    )
    assert.ok(!userinfo.stderr.includes('hunter2'))
    const evalFile = join(p.dir, 'evals', 'waits.eval.ts')
    const overwrite = await runCli(p.dir, ['run', '--events-file', 'evals/waits.eval.ts'])
    assert.equal(overwrite.code, 2)
    assert.match(overwrite.stderr, /waits\.eval\.ts isn't a reeval event stream/)
    assert.equal(readFileSync(evalFile, 'utf8'), gated)
    mkdirSync(join(p.dir, 'out'))
    writeFileSync(join(p.dir, 'out', 'newer.ndjson'), '{"type":"header","schemaVersion":2}\n')
    const newer = await runCli(p.dir, ['attach', 'out/newer.ndjson'])
    assert.equal(newer.code, 2)
    assert.match(newer.stderr, /Upgrade reeval to read it/)
    // A run without --events has no stream to attach to.
    writeFileSync(join(p.dir, 'go'), '')
    // --events takes no value: the eval file after it is a filter, never the stream's file.
    const filtered = await runCli(p.dir, ['run', '--events', 'evals/waits.eval.ts'])
    assert.equal(filtered.code, 0, filtered.stderr)
    assert.equal(readFileSync(evalFile, 'utf8'), gated)
    const filteredId = /Run: +(\S+)/.exec(filtered.stdout)?.[1] ?? ''
    assert.ok(existsSync(join(p.dir, '.reeval', 'events', `${filteredId}.ndjson`)))
    // reeval clean deletes finished runs' streams.
    const cleaned = await runCli(p.dir, ['clean'])
    assert.equal(cleaned.code, 0, cleaned.stderr)
    assert.match(
      cleaned.stdout,
      /Removed the event streams of 1 finished run from \.reeval\/events/,
    )
    assert.ok(!existsSync(join(p.dir, '.reeval', 'events', `${filteredId}.ndjson`)))
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
