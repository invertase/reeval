import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { acquire, useSchedulerChannel } from '../src/scheduler/client.ts'
import { type Rank, type Request, Scheduler } from '../src/scheduler/core.ts'
import { fakeConfig, liveSandboxes, noSignals, project, readRun, runCli } from './helpers.ts'

const rank = (evalId: string, n: number, cell = 0, order = 0): Rank => ({
  eval: evalId,
  file: 'evals/a.eval.ts',
  order,
  n,
  cell,
})

describe('scheduler', () => {
  const setup = () => {
    const granted: string[] = []
    const s = new Scheduler((r: Request) => granted.push(r.id))
    return { s, granted }
  }

  test('grants up to each limit, and the next waiter when a lease is released', () => {
    const { s, granted } = setup()
    for (const id of ['a', 'b', 'c']) s.request({ id, owner: '1', limits: { attempts: 2 } })
    assert.deepEqual(granted, ['a', 'b'])
    assert.equal(s.waiting, 1)
    s.release('a')
    assert.deepEqual(granted, ['a', 'b', 'c'])
    assert.equal(s.inUse('attempts'), 2)
  })

  test("a provider cap holds back only that provider's attempts", () => {
    const { s, granted } = setup()
    s.request({ id: 'd1', owner: '1', limits: { attempts: 3, 'sandbox:docker': 1 } })
    s.request({ id: 'd2', owner: '1', limits: { attempts: 3, 'sandbox:docker': 1 } })
    s.request({ id: 'f1', owner: '1', limits: { attempts: 3 } })
    assert.deepEqual(granted, ['d1', 'f1'])
    s.release('d1')
    assert.deepEqual(granted, ['d1', 'f1', 'd2'])
  })

  test('round-robin across evals, with the cells of one run started together', () => {
    const { s, granted } = setup()
    s.pause()
    for (const e of ['a', 'b']) {
      for (const n of [1, 2]) {
        for (const cell of [0, 1]) {
          s.request({
            id: `${e}#${n}.${cell}`,
            owner: '1',
            limits: { attempts: 1 },
            rank: rank(e, n, cell, e === 'a' ? 0 : 1),
          })
        }
      }
    }
    s.resume()
    for (let i = 0; i < 8; i++) s.release(granted[i] as string)
    assert.deepEqual(granted, [
      'a#1.0',
      'a#1.1',
      'b#1.0',
      'b#1.1',
      'a#2.0',
      'a#2.1',
      'b#2.0',
      'b#2.1',
    ])
  })

  test("a worker's leases and waiting requests go when it does", () => {
    const { s, granted } = setup()
    s.request({ id: 'a', owner: '1', limits: { attempts: 1 } })
    s.request({ id: 'b', owner: '1', limits: { attempts: 1 } })
    s.request({ id: 'c', owner: '2', limits: { attempts: 1 } })
    s.releaseOwner('1')
    assert.deepEqual(granted, ['a', 'c'])
    assert.equal(s.waiting, 0)
  })

  test('workers get leases over their channel; an abort drops a waiting request', async () => {
    // The main process's side, as the engine runs it: requests in, grants out.
    const scheduler = new Scheduler((r) => grant(r.id))
    const grant = useSchedulerChannel((m) =>
      m.t === 'request'
        ? scheduler.request({ id: m.id, owner: '1', limits: m.limits })
        : scheduler.release(m.id),
    )
    {
      const first = await acquire({ x: 1 })
      let second = false
      const waiting = acquire({ x: 1 }).then((lease) => {
        second = true
        return lease
      })
      const aborted = new AbortController()
      const third = acquire({ x: 1 }, { signal: aborted.signal })
      await sleep(50)
      assert.equal(second, false)
      aborted.abort(new Error('stop'))
      await assert.rejects(third, /stop/)
      first.release()
      ;(await waiting).release()
      assert.equal(second, true)
      assert.equal(scheduler.held, 0)
    }
  })
})

type Trace = { name: string; event: 'start' | 'end'; at: number }

const TRACE = `import { appendFileSync } from 'node:fs'
export const traced = async (name: string, fn: () => Promise<unknown>) => {
  const log = (event: string) =>
    appendFileSync(new URL('../trace.jsonl', import.meta.url), JSON.stringify({ name, event, at: Date.now() }) + '\\n')
  log('start')
  try { await fn() } finally { log('end') }
}
`

/** Each attempt sends one turn to the fake agent, which takes `delayMs`. */
const tracedEval = (name: string, options = '{}') => `import { evaluate } from 'reeval'
import { traced } from './trace.ts'
evaluate('${name}', ${options}, async (c) => {
  await traced(\`${name} \${c.attempt.cell.harness}#\${c.attempt.n}\`, () => c.send('go'))
})
`

function readTrace(dir: string): Trace[] {
  const path = join(dir, 'trace.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Trace)
}

/** The most intervals that were open at the same moment. Ends before starts at a tie. */
function maxSpanOverlap(spans: { start: number; end: number }[]): number {
  let running = 0
  let most = 0
  const events = spans
    .flatMap((s) => [
      { at: s.start, d: 1 },
      { at: s.end, d: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.d - b.d)
  for (const e of events) {
    running += e.d
    most = Math.max(most, running)
  }
  return most
}

/** The most attempts that were between their start and end at the same moment. */
function maxOverlap(trace: Trace[]): number {
  let running = 0
  let most = 0
  const events = [...trace].sort((a, b) => a.at - b.at || (a.event === 'end' ? -1 : 1))
  for (const e of events) {
    running += e.event === 'start' ? 1 : -1
    most = Math.max(most, running)
  }
  return most
}

/** The time the traced turns took end to end, one after another. */
const serial = (trace: Trace[]) =>
  trace.reduce((sum, t) => sum + (t.event === 'end' ? t.at : -t.at), 0)

const wall = (trace: Trace[]) =>
  Math.max(...trace.map((t) => t.at)) - Math.min(...trace.map((t) => t.at))

describe('concurrency', () => {
  test('attempt windows overlap when parallel and do not when stacked', () => {
    assert.equal(
      maxSpanOverlap([
        { start: 0, end: 1000 },
        { start: 1000, end: 2000 },
        { start: 2000, end: 3000 },
        { start: 3000, end: 4000 },
      ]),
      1,
    )
    assert.equal(
      maxSpanOverlap([
        { start: 0, end: 1200 },
        { start: 100, end: 1300 },
        { start: 200, end: 1400 },
        { start: 300, end: 1500 },
      ]),
      4,
    )
  })

  test('--concurrency caps attempts across files, and the first slots go to every eval', async () => {
    const p = await project('conc-cap', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 800 }' }),
      'evals/trace.ts': TRACE,
      'evals/a.eval.ts': tracedEval('a', '{ runs: 3 }'),
      'evals/b.eval.ts': tracedEval('b', '{ runs: 3 }'),
    })
    const r = await runCli(p.dir, ['run', '--concurrency', '4'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /· concurrency 4 ·/)
    const trace = readTrace(p.dir)
    assert.equal(trace.length, 12)
    assert.equal(maxOverlap(trace), 4)
    // Against the turns' own time, not 6 × 800 ms: on a slow machine (Windows) a turn takes longer.
    assert.ok(
      wall(trace) < serial(trace) * 0.75,
      `wall ${wall(trace)}ms is no better than serial ${serial(trace)}ms`,
    )
    const firstFour = trace.filter((t) => t.event === 'start').slice(0, 4)
    assert.deepEqual(firstFour.map((t) => t.name[0]).sort(), ['a', 'a', 'b', 'b'])
    const { run } = readRun(p.dir)
    assert.equal(run.config.concurrency, 4)
    assert.deepEqual(
      run.evals.map((e) => e.id),
      ['evals/a.eval.ts › a', 'evals/b.eval.ts › b'],
    )
    // A queued attempt that counted its wait would take about the whole run. Where starting a
    // sandbox is slow (Windows), one round alone passes 3 s, so the bound is the run's span.
    const bound = Math.max(3000, wall(trace))
    for (const a of run.evals.flatMap((e) => e.attempts)) {
      assert.ok(a.durationMs < bound, `attempt ${a.id} took ${a.durationMs}ms, queue time included`)
    }
  })

  test('the config, REEVAL_CONCURRENCY and --concurrency set the cap, in that order', async () => {
    const p = await project('conc-sources', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 400 }', extra: 'concurrency: 2,' }),
      'evals/trace.ts': TRACE,
      'evals/a.eval.ts': tracedEval('a', '{ runs: 4 }'),
    })
    const overlapWith = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
      const tracePath = join(p.dir, 'trace.jsonl')
      if (existsSync(tracePath)) (await import('node:fs')).rmSync(tracePath)
      const r = await runCli(p.dir, ['run', ...args], { env })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      return maxOverlap(readTrace(p.dir))
    }
    assert.equal(await overlapWith([]), 2)
    assert.equal(await overlapWith([], { REEVAL_CONCURRENCY: '3' }), 3)
    assert.equal(await overlapWith(['--concurrency', '1'], { REEVAL_CONCURRENCY: '3' }), 1)
    const bad = await runCli(p.dir, ['run', '--concurrency', '0'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--concurrency must be a whole number of at least 1 \(got 0\)/)
  })

  test('--dry-run sizes the default concurrency from the Docker VM, as a real run does', async () => {
    const p = await project('conc-docker-vm', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness(),
  environment: defineEnvironment('docker', { sandbox: docker() }),
  judge: { model: fakeJudge({ score: 0.9 }) },
})
`,
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async (c) => { await c.send('go') })\n`,
      // A docker CLI whose VM has 3 CPUs and 16 GB, whatever the host has: Node, behind an sh
      // and a .cmd wrapper, so it runs on every OS.
      'bin/docker.js': `const a = process.argv.slice(2).join(' ')\nif (a.startsWith('info') && a.includes('NCPU')) console.log('3 16000000000')\nelse process.exit(1)\n`,
      'bin/docker': `#!/bin/sh\nexec node "$(dirname "$0")/docker.js" "$@"\n`,
      'bin/docker.cmd': '@node "%~dp0docker.js" %*\r\n',
    })
    chmodSync(join(p.dir, 'bin/docker'), 0o755)
    const env = { PATH: `${join(p.dir, 'bin')}${delimiter}${process.env.PATH}` }
    const r = await runCli(p.dir, ['run', '--dry-run', '--json'], { env })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(JSON.parse(r.stdout).concurrency, 3)
  })

  test('a sandbox cap holds on top of the run cap; the judge takes its own leases', async () => {
    const p = await project('conc-sandbox-cap', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness({ delayMs: 400 }),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url), maxConcurrent: 2 }) }),
  judge: { model: fakeJudge({ score: 0.9 }), maxConcurrent: 1 },
})
`,
      'evals/trace.ts': TRACE,
      'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
import { traced } from './trace.ts'
evaluate('a', { runs: 5 }, async (c) => {
  await traced(\`a#\${c.attempt.n}\`, () => c.send('go'))
  expect(await c.judge('ok?')).toPass()
})
`,
    })
    const r = await runCli(p.dir, ['run', '--concurrency', '8'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(maxOverlap(readTrace(p.dir)), 2)
    const bad = await project('conc-bad-cap', {
      'reeval.config.ts': fakeConfig({ extra: 'concurrency: 1.5,' }),
      'evals/a.eval.ts': tracedEval('a'),
    })
    const b = await runCli(bad.dir)
    assert.equal(b.code, 2)
    assert.match(b.stderr, /concurrency in reeval\.config\.ts must be a whole number/)
  })

  test('at concurrency 1, runs go round-robin across evals with their cells together', async () => {
    const p = await project('conc-order', {
      'reeval.config.ts': fakeConfig({ extra: 'runs: 2,' }),
      'evals/trace.ts': TRACE,
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { traced } from './trace.ts'
const harness = [fakeHarness({ id: 'x' }), fakeHarness({ id: 'y' })]
for (const name of ['a', 'b']) {
  evaluate(name, { harness }, async (c) => {
    await traced(\`\${name} \${c.attempt.cell.harness}#\${c.attempt.n}\`, () => c.send('go'))
  })
}
`,
    })
    const r = await runCli(p.dir, ['run', '--concurrency', '1'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const trace = readTrace(p.dir)
    assert.equal(maxOverlap(trace), 1)
    assert.deepEqual(
      trace.filter((t) => t.event === 'start').map((t) => t.name),
      ['a x#1', 'a y#1', 'b x#1', 'b y#1', 'a x#2', 'a y#2', 'b x#2', 'b y#2'],
    )
  })

  test('time spent queued counts toward neither the timeout nor the duration', async () => {
    const p = await project('conc-queue-time', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 1200 }' }),
      'evals/trace.ts': TRACE,
      'evals/a.eval.ts': tracedEval('a', "{ runs: 4, timeout: '3s' }"),
    })
    const r = await runCli(p.dir, ['run', '--concurrency', '1', '--output-logs', 'full'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const attempts = readRun(p.dir).run.evals.flatMap((e) => e.attempts)
    // The fourth waited 3.6 s or more, so passing under its 3 s timeout means the wait didn't count.
    assert.deepEqual(
      attempts.map((a) => a.outcome),
      ['pass', 'pass', 'pass', 'pass'],
    )
    // All four queue before the first starts, so a duration that counted the wait would span the
    // first attempt's turn to the fourth's end. Counted from its own start, the fourth's spans only
    // its own sandbox and turn: shorter by three whole attempts, however slow the machine.
    const trace = readTrace(p.dir)
    const at = (name: string, event: string) =>
      (trace.find((t) => t.name === name && t.event === event) as Trace).at
    const fourth = attempts.find((a) => a.n === 4) as (typeof attempts)[number]
    const span = at('a fake#4', 'end') - at('a fake#1', 'start')
    assert.ok(
      fourth.durationMs < span,
      `${fourth.id}: ${fourth.durationMs}ms, first turn to its end ${span}ms`,
    )
    assert.match(r.stdout, /\[eval#4 fake\] ▶/)
  })

  test('timeouts under concurrency fail every attempt and destroy every sandbox', async () => {
    const p = await project('conc-timeout', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
      'evals/trace.ts': TRACE,
      'evals/a.eval.ts': tracedEval('a', "{ runs: 4, timeout: '1s' }"),
    })
    // Hang detector only: Windows CI has spent ~25s on sandbox startup while the
    // four 1s timeouts still overlapped. Parallelism is the attempt windows below.
    const r = await runCli(p.dir, ['run', '--concurrency', '4'], { timeoutMs: 120_000 })
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const attempts = readRun(p.dir).run.evals.flatMap((e) => e.attempts)
    assert.deepEqual(
      attempts.map((a) => a.error?.kind),
      ['timeout', 'timeout', 'timeout', 'timeout'],
    )
    assert.deepEqual(liveSandboxes(p), [])
    // startedAt + durationMs exclude queue time. A host budget (15s) fails on a
    // slow runner; four serial 1s timeouts still make span ≈ sum(durationMs).
    const windows = attempts.map((a) => {
      assert.ok(a.startedAt, `${a.id} never started`)
      const start = Date.parse(a.startedAt)
      return { start, end: start + a.durationMs }
    })
    assert.equal(maxSpanOverlap(windows), 4, 'all four attempts were in flight')
    const span = Math.max(...windows.map((w) => w.end)) - Math.min(...windows.map((w) => w.start))
    const total = attempts.reduce((sum, a) => sum + a.durationMs, 0)
    assert.ok(span < total * 0.75, `attempt span ${span}ms is no better than serial ${total}ms`)
  })

  test('Ctrl-C cancels running attempts, skips queued ones and destroys every sandbox', {
    skip: noSignals,
  }, async () => {
    const p = await project('conc-sigint', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
      'evals/trace.ts': TRACE,
      'evals/a.eval.ts': tracedEval('a', '{ runs: 3 }'),
      'evals/b.eval.ts': tracedEval('b', '{ runs: 3 }'),
    })
    const r = await runCli(p.dir, ['run', '--concurrency', '3', '--output-logs', 'full'], {
      onOutput: (stdout, pid) => {
        if ((stdout.match(/ turn 1 started$/gm) ?? []).length < 3) return false
        process.kill(-pid, 'SIGINT')
        return true
      },
    })
    assert.equal(r.code, 130, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    assert.equal(run.status, 'interrupted')
    const outcomes = run.evals.flatMap((e) => e.attempts).map((a) => a.error?.kind ?? a.outcome)
    assert.deepEqual(outcomes.filter((o) => o === 'aborted').length, 3, outcomes.join(', '))
    assert.deepEqual(outcomes.filter((o) => o === 'skipped').length, 3, outcomes.join(', '))
    assert.equal(maxOverlap(readTrace(p.dir)), 3)
    assert.deepEqual(liveSandboxes(p), [])
  })
})
