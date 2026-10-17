// Runs in progress: the progress file `reeval run` keeps in `.reeval/staging/<run>/live.json`, how the
// studio reads it (killed runs, corrupt files, landed records), and what it serves and streams.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import type { PlannedItem } from '../src/engine/types.ts'
import type { RunRecord } from '../src/history/types.ts'
import { attemptKey, recordFileName } from '../src/ids.ts'
import { replace, writeLiveProgress } from '../src/live.ts'
import { listLive, liveTranscript, stagingRoot } from '../src/studio/live.ts'
import { createStudioApp, type StudioEvent } from '../src/studio/server.ts'
import type { StudioSource } from '../src/studio/source.ts'
import type { EvalResult } from '../src/ui/events.ts'
import {
  LIVE_FILE,
  type LiveIndex,
  type LiveProgress,
  type LiveRun,
  liveApiPath,
  liveTranscriptPath,
  readableLiveProgress,
} from '../src/view/index.ts'
import { baseEnv, fakeConfig, pkgRoot, project } from './helpers.ts'

const RUN = '20260927T180000Z_abc1234_elliot_k3f9'
const cli = join(pkgRoot, 'dist/cli.js')

const temps: string[] = []
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true })
})
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reeval-live-'))
  temps.push(dir)
  return dir
}

function planned(names: string[], runs = 1): PlannedItem[] {
  return names.flatMap((name) =>
    Array.from({ length: runs }, (_, i) => {
      const id = `evals/a.eval.ts › ${name}`
      const cell = 'fake/default/fake'
      return {
        id,
        key: attemptKey(id, cell, i + 1),
        file: 'evals/a.eval.ts',
        attempt: { name, n: i + 1, cell: { key: cell }, plan: {} },
      } as unknown as PlannedItem
    }),
  )
}

const result = (key: string, state: EvalResult['state'], outcome?: string) =>
  ({
    key,
    state,
    durationMs: 1234,
    meta: outcome ? { outcome } : undefined,
  }) as unknown as EvalResult

const readLive = (dir: string) =>
  JSON.parse(readFileSync(join(dir, LIVE_FILE), 'utf8')) as LiveProgress

describe('the progress file', () => {
  test('starts with every planned attempt queued, and counts each start and finish', async () => {
    const dir = join(await temp(), 'staging', RUN)
    const items = planned(['one', 'two'], 2)
    const live = writeLiveProgress({ dir, runId: RUN, startedAt: new Date(0), planned: items })
    try {
      const first = readLive(dir)
      assert.equal(first.schemaVersion, 1)
      assert.equal(first.runId, RUN)
      assert.equal(first.startedAt, '1970-01-01T00:00:00.000Z')
      assert.equal(first.pid, process.pid)
      assert.equal(first.host, hostname())
      assert.equal(first.phase, 'running')
      assert.equal(first.planned, 4)
      assert.deepEqual(first.counts, {
        done: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        skipped: 0,
        running: 0,
      })
      assert.deepEqual(
        first.attempts.map((a) => [a.name, a.cell, a.n, a.status]),
        [
          ['one', 'fake/default/fake', 1, 'queued'],
          ['one', 'fake/default/fake', 2, 'queued'],
          ['two', 'fake/default/fake', 1, 'queued'],
          ['two', 'fake/default/fake', 2, 'queued'],
        ],
      )
      const [a, b, c, d] = items.map((i) => i.key) as [string, string, string, string]
      live.start(a, Date.parse('2026-09-27T18:00:01Z'))
      live.start(b, Date.now())
      live.start(c, Date.now())
      assert.equal(readLive(dir).counts.running, 3)
      assert.equal(readLive(dir).attempts[0]?.startedAt, '2026-09-27T18:00:01.000Z')
      live.end(result(a, 'passed', 'pass'))
      live.end(result(b, 'failed', 'fail'))
      live.end(result(c, 'failed', 'infra_error'))
      live.end(result('not planned', 'passed'))
      const after = readLive(dir)
      assert.deepEqual(after.counts, {
        done: 3,
        passed: 1,
        failed: 1,
        errored: 1,
        skipped: 0,
        running: 0,
      })
      assert.deepEqual(
        after.attempts.map((x) => [x.status, x.durationMs]),
        [
          ['pass', 1234],
          ['fail', 1234],
          ['infra_error', 1234],
          ['queued', null],
        ],
      )
      live.start(d, Date.now())
      live.end(result(d, 'skipped'))
      live.phase('finishing')
      assert.equal(readLive(dir).phase, 'finishing')
      assert.equal(readLive(dir).counts.done, 4)
      assert.deepEqual(readdirSync(dir), [LIVE_FILE], 'no temp file is left behind')
    } finally {
      live.remove()
    }
    assert.equal(existsSync(join(dir, LIVE_FILE)), false)
  })

  test("a rename Windows refuses while the file is open is tried again, and others aren't", () => {
    const busy = (code: string, times: number) => {
      let calls = 0
      const rename = () => {
        calls++
        if (calls <= times) throw Object.assign(new Error(code), { code })
      }
      return { rename, calls: () => calls }
    }
    const instant = { wait() {} }
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const r = busy(code, 3)
      replace('a', 'b', r.rename, instant)
      assert.equal(r.calls(), 4, code)
    }
    const gone = busy('ENOENT', 1)
    assert.throws(() => replace('a', 'b', gone.rename, instant), /ENOENT/)
    assert.equal(gone.calls(), 1)
    const stuck = busy('EPERM', 100)
    let t = 0
    assert.throws(
      () => replace('a', 'b', stuck.rename, { now: () => ++t, wait() {}, busyMs: 20 }),
      /EPERM/,
    )
    assert.equal(stuck.calls(), 20)
  })

  test('is replaced whole: a reader polling it never sees a partial file', async () => {
    const dir = join(await temp(), RUN)
    const items = planned(Array.from({ length: 200 }, (_, i) => `eval ${i}`))
    const live = writeLiveProgress({ dir, runId: RUN, startedAt: new Date(), planned: items })
    const reader = new Worker(
      `const { readFileSync } = require('node:fs')
       const { workerData, parentPort } = require('node:worker_threads')
       const busy = new Set(['EPERM', 'EACCES', 'EBUSY'])
       let reads = 0, bad = 0, missed = 0
       parentPort.on('message', () => parentPort.postMessage({ reads, bad, missed }))
       const loop = () => {
         try { JSON.parse(readFileSync(workerData, 'utf8')); reads++ }
         catch (e) { if (e && busy.has(e.code)) missed++; else bad++ }
         setImmediate(loop)
       }
       loop()`,
      { eval: true, workerData: join(dir, LIVE_FILE) },
    )
    const stats = () =>
      new Promise<{ reads: number; bad: number; missed: number }>((resolve) => {
        reader.once('message', resolve)
        reader.postMessage('stats')
      })
    const shown = (s: { reads: number; bad: number; missed: number }) =>
      `the reader read ${s.reads} times (${s.bad} partial, ${s.missed} misses)`
    try {
      const ready = Date.now() + 5000
      while ((await stats()).reads === 0) {
        if (Date.now() > ready) assert.fail('the reader never started')
        await sleep(1)
      }
      for (const item of items) {
        live.start(item.key, Date.now())
        live.end(result(item.key, 'passed', 'pass'))
        await sleep(0)
      }
      const until = Date.now() + 5000
      let last = await stats()
      while (last.reads <= 100 && last.bad === 0 && Date.now() < until) {
        live.phase('running')
        await sleep(5)
        last = await stats()
      }
      assert.equal(last.bad, 0, shown(last))
      assert.ok(last.reads > 100, shown(last))
      assert.equal(readLive(dir).counts.passed, 200)
    } finally {
      await reader.terminate()
      live.remove()
    }
  })

  test('beats while the run is alive, and stop() freezes it', async () => {
    const dir = join(await temp(), RUN)
    let t = Date.parse('2026-09-27T18:00:00Z')
    const live = writeLiveProgress({
      dir,
      runId: RUN,
      startedAt: new Date(t),
      planned: planned(['one']),
      heartbeatMs: 20,
      now: () => {
        t += 1000
        return new Date(t)
      },
    })
    const beat = () => Date.parse(readLive(dir).heartbeatAt)
    const first = beat()
    await sleep(120)
    assert.ok(beat() > first, 'the heartbeat moved on')
    live.stop()
    const frozen = beat()
    await sleep(80)
    assert.equal(beat(), frozen)
    live.start(planned(['one'])[0]?.key as string, Date.now())
    assert.equal(readLive(dir).counts.running, 0, 'nothing is written once stopped')
  })

  test('a planned attempt the plan skips starts skipped and counts as done', async () => {
    const dir = join(await temp(), RUN)
    const items = planned(['one', 'two'])
    ;(items[1]?.attempt.plan as { skip?: string }).skip = 'no key'
    const live = writeLiveProgress({ dir, runId: RUN, startedAt: new Date(), planned: items })
    live.stop()
    assert.deepEqual(
      readLive(dir).attempts.map((a) => a.status),
      ['queued', 'skipped'],
    )
    assert.equal(readLive(dir).counts.done, 1)
  })
})

describe('reading a progress file', () => {
  const valid = (): Record<string, unknown> => ({
    schemaVersion: 1,
    runId: RUN,
    startedAt: '2026-09-27T18:00:00.000Z',
    pid: 1,
    host: 'h',
    heartbeatAt: '2026-09-27T18:00:02.000Z',
    phase: 'running',
    planned: 99,
    counts: { done: 99, passed: 99, failed: 0, errored: 0, skipped: 0, running: 0 },
    attempts: [
      {
        key: 'k',
        evalId: 'e',
        name: 'n',
        file: 'f',
        cell: 'c',
        n: 1,
        status: 'pass',
        startedAt: null,
        durationMs: 5,
      },
    ],
  })

  test('recomputes counts from the attempts, and ignores unknown fields', () => {
    const read = readableLiveProgress({ ...valid(), extra: { from: 'a newer reeval' } })
    assert.ok(read)
    assert.equal(read.planned, 1)
    assert.equal(read.counts.done, 1)
    assert.equal(read.counts.passed, 1)
  })

  test('anything it cannot read is null, never a throw', () => {
    const broken: unknown[] = [
      null,
      'live',
      [],
      { ...valid(), schemaVersion: 2 },
      { ...valid(), schemaVersion: undefined },
      { ...valid(), pid: 'one' },
      { ...valid(), phase: 'paused' },
      { ...valid(), attempts: 'none' },
      { ...valid(), attempts: [{ key: 'k' }] },
      { ...valid(), attempts: [{ ...(valid().attempts as object[])[0], status: 'bored' }] },
      { ...valid(), startedAt: 7 },
    ]
    for (const b of broken) assert.equal(readableLiveProgress(b), null, JSON.stringify(b))
  })
})

/** A project root with `.reeval/staging/<run>/live.json` for each progress given. */
async function stagingProject(files: Record<string, string | LiveProgress>) {
  const root = await temp()
  for (const [runId, value] of Object.entries(files)) {
    const dir = join(stagingRoot(root), runId)
    await mkdir(join(dir, 'evals'), { recursive: true })
    await writeFile(join(dir, LIVE_FILE), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const source: StudioSource = { root, historyDir: join(root, 'evals/.history'), scratch: true }
  return { root, source }
}

const progress = (runId: string, patch: Partial<LiveProgress> = {}): LiveProgress => ({
  schemaVersion: 1,
  runId,
  startedAt: new Date(Date.now() - 5000).toISOString(),
  pid: process.pid,
  host: hostname(),
  heartbeatAt: new Date().toISOString(),
  phase: 'running',
  planned: 2,
  counts: { done: 1, passed: 1, failed: 0, errored: 0, skipped: 0, running: 1 },
  attempts: [
    {
      key: attemptKey('evals/a.eval.ts › one', 'fake/default/fake', 1),
      evalId: 'evals/a.eval.ts › one',
      name: 'one',
      file: 'evals/a.eval.ts',
      cell: 'fake/default/fake',
      n: 1,
      status: 'pass',
      startedAt: new Date(Date.now() - 4000).toISOString(),
      durationMs: 2000,
    },
    {
      key: attemptKey('evals/a.eval.ts › one', 'fake/default/fake', 2),
      evalId: 'evals/a.eval.ts › one',
      name: 'one',
      file: 'evals/a.eval.ts',
      cell: 'fake/default/fake',
      n: 2,
      status: 'running',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      durationMs: null,
    },
  ],
  ...patch,
})

/** A pid that was just alive and has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

const stamp = (n: number) => `20260927T18000${n}Z_abc1234_elliot_k3f9`

describe('the studio reads live runs', () => {
  test('running, stopped (process gone, or quiet), corrupt and landed runs', async () => {
    const quiet = new Date(Date.now() - 60_000).toISOString()
    const { root, source } = await stagingProject({
      [stamp(1)]: progress(stamp(1)),
      [stamp(2)]: progress(stamp(2), { pid: deadPid() }),
      [stamp(3)]: progress(stamp(3), { host: 'another-host', heartbeatAt: quiet }),
      [stamp(4)]: progress(stamp(4), { host: 'another-host', pid: 1 }),
      [stamp(5)]: '{"schemaVersion":1,"runId":"2026092',
      [stamp(6)]: progress(stamp(6), { phase: 'finishing' }),
      [stamp(7)]: progress(stamp(7)),
      [stamp(8)]: progress(stamp(9)),
      'not-a-run': progress('not-a-run'),
    })
    await mkdir(join(root, '.reeval/runs'), { recursive: true })
    await writeFile(join(root, '.reeval/runs', `${stamp(7)}.json`), '{}')
    const runs = await listLive(source)
    assert.deepEqual(
      runs.map((r) => [r.runId, r.state]),
      [
        [stamp(6), 'finishing'],
        [stamp(4), 'running'],
        [stamp(3), 'stopped'],
        [stamp(2), 'stopped'],
        [stamp(1), 'running'],
      ],
    )
    const run = runs.at(-1) as LiveRun
    assert.equal('pid' in run || 'host' in run || 'heartbeatAt' in run, false)
    assert.equal(run.counts.done, 1)
    assert.deepEqual(await listLive({ ...source, scratch: false }), [])
    // A quiet run on this host is stopped too, whatever its pid says.
    assert.equal(
      (await listLive(source, { now: Date.now() + 60_000 })).every((r) => r.state === 'stopped'),
      true,
    )
  })

  test('with no staging folder there are none', async () => {
    const root = await temp()
    assert.deepEqual(
      await listLive({ root, historyDir: join(root, 'evals/.history'), scratch: true }),
      [],
    )
  })
})

const HOST = '127.0.0.1:4984'

describe('the studio serves and streams live runs', () => {
  const secret = `sk-ant-${'x'.repeat(32)}`
  async function setup() {
    const { root, source } = await stagingProject({ [RUN]: progress(RUN) })
    const done = progress(RUN).attempts[0]?.key as string
    const staged = {
      turns: [
        {
          startedAt: '2026-09-27T18:00:01.000Z',
          durationMs: 2000,
          status: 'ok',
          prompt: 'write hello.txt',
          transcript: [{ type: 'text', atMs: 5, text: `done, with ${secret}` }],
        },
      ],
    }
    await writeFile(
      join(stagingRoot(root), RUN, 'evals', recordFileName(done)),
      JSON.stringify(staged),
    )
    const listeners = new Set<(e: StudioEvent) => void>()
    const app = createStudioApp({
      source,
      appDir: root,
      reeval: 'test',
      project: 'live',
      token: null,
      hosts: [],
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    })
    const send = (e: StudioEvent) => {
      for (const l of listeners) l(e)
    }
    return { root, source, app, done, send, listeners }
  }
  const get = (app: ReturnType<typeof createStudioApp>, path: string) =>
    app.request(`http://${HOST}/${path}`, { headers: { host: HOST } })

  test('/api/live lists them; a finished attempt serves its redacted transcript', async () => {
    const { root, app, done } = await setup()
    const index = (await (await get(app, liveApiPath)).json()) as LiveIndex
    assert.deepEqual(
      index.runs.map((r) => [r.runId, r.state, r.counts.done, r.planned]),
      [[RUN, 'running', 1, 2]],
    )

    const res = await get(app, liveTranscriptPath(RUN, done))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-security-policy'), 'sandbox')
    const text = await res.text()
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.deepEqual(
      lines.map((l) => l.type),
      ['prompt', 'text', 'turn-end'],
    )
    assert.doesNotMatch(text, /sk-ant-x{32}/)
    assert.match(text, /done, with/)

    const running = progress(RUN).attempts[1]?.key as string
    await writeFile(join(stagingRoot(root), RUN, 'evals', recordFileName(running)), '{}')
    for (const path of [
      liveTranscriptPath(RUN, running),
      liveTranscriptPath(RUN, `${done}0`),
      liveTranscriptPath(RUN, '../../../reeval.config.ts'),
      liveTranscriptPath('not-a-run', done),
      liveTranscriptPath(stamp(1), done),
    ]) {
      assert.equal((await get(app, path)).status, 404, path)
    }
  })

  test("a staged record that's a symlink out of the run is never served", async () => {
    const { root, source, done } = await setup()
    const file = join(stagingRoot(root), RUN, 'evals', recordFileName(done))
    const outside = join(root, 'outside.json')
    await writeFile(outside, await readFile(file))
    await rm(file)
    await symlink(outside, file)
    assert.equal(await liveTranscript(source, RUN, done), null)
  })

  test('/api/events streams run.progress with the runs, and history.changed', async () => {
    const { app, send, listeners } = await setup()
    const res = await get(app, 'api/events')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    const until = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended: ${text}`)
        text += decoder.decode(value)
      }
    }
    await until(/event: ready/)
    send({ type: 'run.progress', runs: [{ ...progress(RUN), state: 'running' } as LiveRun] })
    send({ type: 'history.changed' })
    await until(/event: history\.changed/)
    const progressEvent = /event: run\.progress\ndata: (.+)\n/.exec(text)
    assert.ok(progressEvent, text)
    const data = JSON.parse(progressEvent[1] as string) as LiveIndex
    assert.equal(data.runs[0]?.runId, RUN)
    await reader.cancel()
    await sleep(20)
    assert.equal(listeners.size, 0, 'a closed stream unsubscribes')
  })
})

/**
 * Each distinct `done/planned` a run's progress file showed, polled until the CLI exits.
 * `onStep` hears each new step's done count.
 */
async function watchRun(
  dir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  onStep: (done: number) => void = () => {},
) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: dir,
    env: { ...baseEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  const seen: string[] = []
  let runId: string | undefined
  let open = true
  void exited.then(() => (open = false))
  while (open) {
    const staging = join(dir, '.reeval/staging')
    const [name] = existsSync(staging) ? readdirSync(staging) : []
    const file = name && join(staging, name, LIVE_FILE)
    if (file && existsSync(file)) {
      try {
        const p = readableLiveProgress(JSON.parse(readFileSync(file, 'utf8')))
        if (p) {
          runId = p.runId
          const step = `${p.counts.done}/${p.planned}${p.phase === 'running' ? '' : ` ${p.phase}`}`
          if (seen.at(-1) !== step) {
            seen.push(step)
            onStep(p.counts.done)
          }
        }
      } catch {}
    }
    await sleep(25)
  }
  return { code: await exited, seen, runId, output }
}

describe('reeval run keeps its progress file', () => {
  const evalFile = `import { evaluate, expect } from 'reeval'
evaluate('writes hello', { runs: 3 }, async (c) => {
  await c.send('write hello.txt')
  await expect(c.exec('test -f hello.txt')).toSucceed()
})
`
  const agent = (delayMs: number) => `{ files: { 'hello.txt': 'hi\\n' }, delayMs: ${delayMs} }`

  test('from 0/N to done, then the record replaces it', async () => {
    const p = await project('live-run', {
      'reeval.config.ts': fakeConfig({ harness: agent(0) }),
      'evals/hello.eval.ts': `import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { evaluate, expect } from 'reeval'
evaluate('writes hello', { runs: 3 }, async (c) => {
  while (!existsSync(new URL(\`../gate-\${c.attempt.n}\`, import.meta.url))) await sleep(20)
  await c.send('write hello.txt')
  await expect(c.exec('test -f hello.txt')).toSucceed()
})
`,
    })
    // Attempt n starts its turn once the test has seen n - 1 done, so no count goes unseen however
    // slow the machine. The last one lasts only until the record replaces the file: the record
    // shows it.
    const r = await watchRun(p.dir, ['run', '--concurrency', '1'], {}, (done) =>
      writeFileSync(join(p.dir, `gate-${done + 1}`), ''),
    )
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(
      r.seen.filter((s) => !s.startsWith('3/3')),
      ['0/3', '1/3', '2/3'],
      r.seen.join(' '),
    )
    assert.ok(r.runId)
    assert.equal(existsSync(join(p.dir, '.reeval/staging', r.runId)), false, 'staging is gone')
    assert.ok(existsSync(join(p.dir, '.reeval/runs', `${r.runId}.json`)), 'the record landed')
    const source = { root: p.dir, historyDir: join(p.dir, 'evals/.history'), scratch: true }
    assert.deepEqual(await listLive(source), [])
    const record = readFileSync(join(p.dir, '.reeval/runs', `${r.runId}.json`), 'utf8')
    assert.doesNotMatch(record, /"(queued|running)"/, 'nothing live reaches the record')
    const outcomes = (JSON.parse(record) as RunRecord).evals[0]?.attempts.map((a) => a.outcome)
    assert.deepEqual(outcomes, ['pass', 'pass', 'pass'])
  })

  test('a killed run is shown as stopped, with what it had finished', async () => {
    // The second attempt parks in Node after its turn, so the kill lands while no shell or git
    // is running in the sandbox: on Windows, taskkill doesn't reach what MSYS starts. The worker
    // writes its pid, so the test ends only once the whole tree is gone.
    const p = await project('live-killed', {
      'reeval.config.ts': fakeConfig({ harness: agent(0) }),
      'evals/hello.eval.ts': `import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { evaluate } from 'reeval'
evaluate('writes hello', { runs: 20 }, async (c) => {
  writeFileSync(new URL('../worker.pid', import.meta.url), String(process.pid))
  await c.send('write hello.txt')
  if (c.attempt.n === 1) return
  writeFileSync(new URL('../parked', import.meta.url), '')
  await sleep(600_000, undefined, { signal: c.signal }).catch(() => {})
})
`,
    })
    const child = spawn(process.execPath, [cli, 'run', '--concurrency', '1'], {
      cwd: p.dir,
      env: baseEnv,
      detached: true,
      stdio: 'ignore',
    })
    const source = { root: p.dir, historyDir: join(p.dir, 'evals/.history'), scratch: true }
    let runs: LiveRun[] = []
    while (!existsSync(join(p.dir, 'parked')) || runs[0]?.counts.done !== 1) {
      await sleep(50)
      runs = await listLive(source)
    }
    assert.equal(runs[0]?.state, 'running')
    // Its process group; Windows has none, so its process tree.
    if (process.platform === 'win32') {
      // taskkill exits 128 when part of the tree is already gone; the exit below is what counts.
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } catch {}
    } else process.kill(-(child.pid as number), 'SIGKILL')
    await new Promise((resolve) => child.on('exit', resolve))
    const worker = Number(readFileSync(join(p.dir, 'worker.pid'), 'utf8'))
    const alive = () => {
      try {
        process.kill(worker, 0)
        return true
      } catch {
        return false
      }
    }
    while (alive()) await sleep(50)
    runs = await listLive(source)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.state, 'stopped')
    assert.equal(runs[0]?.counts.done, 1)
  })

  test('a run that stops at the plan leaves no progress file', async () => {
    const p = await project('live-dry', {
      'reeval.config.ts': fakeConfig({ harness: agent(0) }),
      'evals/hello.eval.ts': evalFile,
    })
    const r = await watchRun(p.dir, ['run', '--dry-run'])
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(r.seen, [])
  })
})
