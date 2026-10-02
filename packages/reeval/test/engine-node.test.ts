// The engine's main process (engine/node.ts) with scripted workers: collecting for the plan, load
// and usage errors, filters, leases across workers, events, cancel and workers that die.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
import { runEngine } from '../src/engine/node.ts'
import type { Exit, Spawn, WorkerProcess } from '../src/engine/pool.ts'
import { type FromWorker, PROTOCOL, type ToWorker, type WireTest } from '../src/engine/protocol.ts'
import type { CollectedPlan, EngineOptions } from '../src/engine/types.ts'
import type { AttemptMeta, RunContext } from '../src/types.ts'
import type { EsEvent } from '../src/ui/events.ts'
import { tempDir } from './helpers.ts'

type Init = Extract<ToWorker, { t: 'init' }>
type Ctl = {
  init: Init
  emit(message: FromWorker): void
  exit(exit?: Partial<Exit>): void
  received: ToWorker[]
  output(stream: 'stdout' | 'stderr', text: string): void
}
type Script = (ctl: Ctl) => void | Promise<void>

/** Workers that say hello, then act out `script` for each file and pass. */
function fakeSpawn(
  script: Script,
  options: { hello?: number | false; helloAfter?: (n: number) => number } = {},
) {
  let spawns = 0
  const spawned: string[] = []
  const spawn: Spawn = () => {
    const listeners: ((m: FromWorker) => void)[] = []
    const outputs: ((s: 'stdout' | 'stderr', t: string) => void)[] = []
    let resolveExit: (exit: Exit) => void = () => {}
    const exited = new Promise<Exit>((resolve) => {
      resolveExit = resolve
    })
    const received: ToWorker[] = []
    let ctl: Ctl | undefined
    const emit = (m: FromWorker) =>
      queueMicrotask(() => {
        for (const l of listeners) l(m)
      })
    const worker: WorkerProcess = {
      send: (m) => {
        received.push(m)
        if (m.t === 'init') {
          spawned.push(`${basename(m.file)}:${m.select ? m.select.join(',') : 'collect'}`)
          ctl = {
            init: m,
            emit,
            received,
            exit: (e = {}) => setTimeout(() => resolveExit({ code: 0, signal: null, ...e }), 1),
            output: (s, t) => {
              for (const o of outputs) o(s, t)
            },
          }
          void script(ctl)
        }
      },
      onMessage: (l) => void listeners.push(l),
      onOutput: (l) => void outputs.push(l),
      exited,
      kill: () => resolveExit({ code: null, signal: 'SIGKILL' }),
    }
    const delay = options.helloAfter?.(++spawns) ?? 0
    if (options.hello !== false)
      setTimeout(() => emit({ t: 'hello', protocol: options.hello ?? PROTOCOL }), delay)
    else setTimeout(() => resolveExit({ code: 1, signal: null }), 1)
    return worker
  }
  return { spawn, spawned }
}

const attempt = (name: string, extra: Partial<AttemptMeta> = {}) =>
  ({
    name,
    groups: [],
    cell: { key: 'fake/-/fake' },
    n: 1,
    plan: {},
    ...extra,
  }) as unknown as AttemptMeta

function project(files: string[]) {
  const root = tempDir('node')
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true })
    writeFileSync(join(root, f), '')
  }
  const run = {
    config: {
      root,
      include: ['evals/**/*.eval.ts'],
      history: { dir: join(root, 'evals/.history') },
    },
    stagingDir: join(root, '.reeval/staging/x'),
    concurrency: 4,
  } as unknown as RunContext
  return { root, run }
}

type Options = Partial<EngineOptions> & { run: RunContext }
const engine = (options: Options, spawn: Spawn) => runEngine({ filters: [], ...options }, spawn)

/** Collects `tests` per file, then in the run pass passes every selected run-mode test. */
const passing =
  (tests: Record<string, WireTest[]>, extra?: (ctl: Ctl) => void): Script =>
  (ctl) => {
    const list = tests[basename(ctl.init.file)] ?? []
    ctl.emit({ t: 'collected', tests: list })
    if (ctl.init.select) {
      extra?.(ctl)
      for (const t of list) {
        const run = ctl.init.select.includes(t.index) && t.mode === 'run'
        if (run) ctl.emit({ t: 'start', index: t.index, at: 1 })
        ctl.emit({
          t: 'result',
          index: t.index,
          result: run
            ? { state: 'passed', errors: [], durationMs: 1.4 }
            : { state: 'skipped', errors: [], durationMs: 0 },
        })
      }
      ctl.emit({ t: 'ready' })
    }
    ctl.emit({ t: 'done' })
    ctl.exit()
  }

const test0 = (index: number, name: string, extra: Partial<WireTest> = {}): WireTest => ({
  index,
  name,
  groups: [],
  mode: 'run',
  ...extra,
})

describe('runEngine: collecting and the plan', () => {
  test('no eval files, or a path filter that picks none, is noFiles', async () => {
    const { run } = project([])
    const r = await engine({ run }, fakeSpawn(() => assert.fail('no worker')).spawn)
    assert.equal(r.noFiles, true)
  })

  test('the plan: attempts by file then declaration, skipped evals once each, todos, and filters', async () => {
    const { run } = project(['evals/b.eval.ts', 'evals/a.eval.ts'])
    const tests = {
      'a.eval.ts': [
        test0(0, 'x [fake/-/fake#1]', { attempt: attempt('x') }),
        test0(1, 'x [fake/-/fake#2]', { attempt: attempt('x', { n: 2 }) }),
        test0(2, 'parked [fake/-/fake#1]', {
          mode: 'skip',
          attempt: attempt('parked', { plan: { skip: true } } as never),
        }),
        test0(3, 'y [fake/-/fake#1]', { mode: 'skip', attempt: attempt('y') }),
        test0(4, 'y [fake/-/fake#2]', { mode: 'skip', attempt: attempt('y', { n: 2 }) }),
      ],
      'b.eval.ts': [test0(0, 'later', { mode: 'todo', groups: ['g'] })],
    }
    let plan: CollectedPlan | undefined
    const { spawn, spawned } = fakeSpawn(passing(tests))
    const r = await engine(
      {
        run,
        onPlan: async (p) => {
          plan = p
          return false
        },
      },
      spawn,
    )
    assert.equal(r.stopped, true)
    assert.deepEqual(spawned.sort(), ['a.eval.ts:collect', 'b.eval.ts:collect'])
    assert.deepEqual(
      plan?.planned.map((p) => p.key),
      [
        'evals/a.eval.ts › x # fake/-/fake#1',
        'evals/a.eval.ts › x # fake/-/fake#2',
        'evals/a.eval.ts › parked # fake/-/fake#1',
      ],
    )
    assert.deepEqual(plan?.excluded, [
      { id: 'evals/a.eval.ts › y', mode: 'skip' },
      { id: 'evals/b.eval.ts › g › later', mode: 'todo' },
    ])
    assert.deepEqual([plan?.matched, plan?.unmatched], [6, []])
  })
})

describe('runEngine: files that fail to load', () => {
  test('load errors are grouped by message, and name every file', async () => {
    const { run } = project(['evals/a.eval.ts', 'evals/b.eval.ts', 'evals/c.eval.ts'])
    const { spawn } = fakeSpawn((ctl) => {
      const name = basename(ctl.init.file)
      if (name === 'c.eval.ts') {
        ctl.exit({ code: null, signal: 'SIGKILL' })
        return
      }
      ctl.emit({
        t: 'load-error',
        error: { name: 'TsconfigError', message: '\x1b[31mbad tsconfig\x1b[39m ' },
      })
      ctl.emit({ t: 'done' })
      ctl.exit()
    })
    await assert.rejects(engine({ run }, spawn), (e: Error) => {
      assert.equal(e.name, 'UsageError')
      assert.equal(
        e.message,
        '3 eval files failed to load:\nevals/a.eval.ts, evals/b.eval.ts: bad tsconfig\nevals/c.eval.ts: the worker exited while loading it (signal SIGKILL)',
      )
      return true
    })
    const one = project(['evals/a.eval.ts'])
    await assert.rejects(
      engine({ run: one.run }, spawn),
      /^UsageError: An eval file failed to load:\n/,
    )
  })

  for (const [name, message, expected] of [
    [
      'OnlyInCiError',
      'no',
      "evaluate.only/group.only in evals/a.eval.ts isn't allowed in CI (CI is set). Remove it, or run with CI=false.",
    ],
    ['UsageError', 'twice', 'evals/a.eval.ts: twice'],
    ['DefinitionError', 'nested', 'evals/a.eval.ts: nested'],
  ] as const) {
    test(`a ${name} at load is a usage error`, async () => {
      const { run } = project(['evals/a.eval.ts'])
      const { spawn } = fakeSpawn((ctl) => {
        ctl.emit({ t: 'load-error', error: { name, message } })
        ctl.exit()
      })
      await assert.rejects(
        engine({ run }, spawn),
        (e: Error) => e.name === 'UsageError' && e.message === expected,
      )
    })
  }

  test('a worker in another protocol, or that dies before hello, fails the run', async () => {
    const { run } = project(['evals/a.eval.ts'])
    await assert.rejects(
      engine({ run }, fakeSpawn(() => {}, { hello: PROTOCOL + 1 }).spawn),
      /engine protocol/,
    )
    await assert.rejects(
      engine({ run }, fakeSpawn(() => {}, { hello: false }).spawn),
      /exited before it started/,
    )
  })
})

describe('runEngine: running', () => {
  const two = {
    'a.eval.ts': [
      test0(0, 'one [fake/-/fake#1]', { attempt: attempt('one') }),
      test0(1, 'skipped', { mode: 'skip' }),
      test0(2, 'placeholder', { mode: 'todo' }),
    ],
    'b.eval.ts': [test0(0, 'two [fake/-/fake#1]', { attempt: attempt('two', { groups: ['g'] }) })],
  }

  test('events and results: by file then declaration, todos flagged, durations rounded', async () => {
    const { run } = project(['evals/a.eval.ts', 'evals/b.eval.ts'])
    const events: EsEvent[] = []
    let files = 0
    const { spawn, spawned } = fakeSpawn(
      passing(two, (ctl) => {
        if (!ctl.init.file.endsWith('a.eval.ts')) return
        ctl.output('stdout', 'raw write\n')
        ctl.emit({ t: 'progress', index: 0, progress: { kind: 'sandbox' } })
        ctl.emit({ t: 'debug', index: 0, line: { phase: 'x' } as never })
        ctl.emit({ t: 'log', index: 0, at: 5, stream: 'stdout', text: 'hi\n' })
        ctl.emit({ t: 'log', at: 6, stream: 'stderr', text: 'file-level\n' })
        ctl.emit({ t: 'log', index: 99, at: 7, stream: 'stdout', text: 'unknown\n' })
        ctl.emit({ t: 'unhandled', error: { message: 'stray' } })
        ctl.emit({ t: 'unhandled', error: {} })
      }),
    )
    const debug = process.env.REEVAL_DEBUG
    const written: string[] = []
    const write = process.stderr.write
    process.env.REEVAL_DEBUG = '1'
    process.stderr.write = ((text: string) => written.push(text) > 0) as typeof write
    let r: Awaited<ReturnType<typeof engine>>
    try {
      r = await engine(
        { run, onEvent: (e) => events.push(e), onRunStart: (n) => (files = n) },
        spawn,
      )
    } finally {
      process.stderr.write = write
      if (debug === undefined) delete process.env.REEVAL_DEBUG
      else process.env.REEVAL_DEBUG = debug
    }
    assert.deepEqual(written, ['raw write\n'], 'raw output shows only with REEVAL_DEBUG')
    assert.equal(files, 2)
    assert.deepEqual(spawned.sort(), [
      'a.eval.ts:0,1,2',
      'a.eval.ts:collect',
      'b.eval.ts:0',
      'b.eval.ts:collect',
    ])
    assert.deepEqual(
      r.evals.map((e) => [e.id, e.state, e.durationMs, e.todo ?? false]),
      [
        ['evals/a.eval.ts › one', 'passed', 1, false],
        ['evals/a.eval.ts › skipped', 'skipped', 0, false],
        ['evals/a.eval.ts › placeholder', 'skipped', 0, true],
        ['evals/b.eval.ts › g › two', 'passed', 1, false],
      ],
    )
    assert.deepEqual(r.unhandledErrors.sort(), ['[object Object]', 'stray'])
    const types = events.map((e) => e.type)
    for (const type of ['collected', 'eval-start', 'eval-progress', 'debug', 'log', 'eval-end'])
      assert.ok(types.includes(type as never), type)
    const logs = events.filter((e) => e.type === 'log') as Extract<EsEvent, { type: 'log' }>[]
    assert.deepEqual(
      logs
        .filter((l) => l.text === 'hi\n' || l.text === 'unknown\n' || l.text === 'raw write\n')
        .map((l) => [l.text, l.key]),
      [
        ['hi\n', 'evals/a.eval.ts › one # fake/-/fake#1'],
        ['unknown\n', undefined],
      ],
    )
    const collected = events.find((e) => e.type === 'collected') as Extract<
      EsEvent,
      { type: 'collected' }
    >
    assert.deepEqual(
      collected.evals.map((e) => e.skipped),
      collected.file === 'evals/a.eval.ts' ? [false, true, true] : [false],
    )
  })

  test('a name filter runs only the files it picks in, only its evals, and results only for them', async () => {
    const { run } = project(['evals/a.eval.ts', 'evals/b.eval.ts'])
    let plan: CollectedPlan | undefined
    const { spawn, spawned } = fakeSpawn(passing(two))
    const r = await engine(
      {
        run,
        filters: ['one', 'nothing matches this'],
        onPlan: async (p) => {
          plan = p
          return true
        },
      },
      spawn,
    )
    assert.deepEqual(plan?.unmatched, ['nothing matches this'])
    assert.deepEqual(spawned.sort(), ['a.eval.ts:0', 'a.eval.ts:collect', 'b.eval.ts:collect'])
    assert.deepEqual(
      r.evals.map((e) => e.id),
      ['evals/a.eval.ts › one'],
    )
    const none = await engine(
      {
        run,
        filters: ['zzz'],
        onPlan: async (p) => {
          assert.deepEqual(p.unmatched, [], 'every part unmatched is left to the run')
          return true
        },
      },
      fakeSpawn(passing(two)).spawn,
    )
    assert.equal(none.noFiles, true)
  })

  test('leases: the first round gathers before any grant, then workers get grants and release', async () => {
    const { run } = project(['evals/a.eval.ts', 'evals/b.eval.ts'])
    const order: string[] = []
    const tests = { 'a.eval.ts': [test0(0, 'a')], 'b.eval.ts': [test0(0, 'b')] }
    const { spawn } = fakeSpawn((ctl) => {
      const name = basename(ctl.init.file) as 'a.eval.ts'
      ctl.emit({ t: 'collected', tests: tests[name] })
      if (!ctl.init.select) {
        ctl.emit({ t: 'done' })
        ctl.exit()
        return
      }
      const limits = { attempts: 1 }
      ctl.emit({
        t: 'request',
        id: '1',
        limits,
        ...(name === 'a.eval.ts'
          ? { rank: { eval: name, file: name, order: 0, n: 1, cell: 0 } }
          : {}),
      })
      const wait = setInterval(() => {
        if (!ctl.received.some((m) => m.t === 'grant')) return
        clearInterval(wait)
        order.push(name)
        ctl.emit({ t: 'result', index: 0, result: { state: 'passed', errors: [], durationMs: 0 } })
        ctl.emit({ t: 'release', id: '1' })
        ctl.emit({ t: 'done' })
        ctl.exit()
      }, 2)
      if (name === 'b.eval.ts') setTimeout(() => ctl.emit({ t: 'ready' }), 20)
      else ctl.emit({ t: 'ready' })
    })
    const r = await engine({ run }, spawn)
    // Without the gather, a (ready at once) would be granted before b asked. With it, both have
    // asked, and b's unranked request is served first, as the scheduler serves unranked ones.
    assert.deepEqual(order, ['b.eval.ts', 'a.eval.ts'])
    assert.deepEqual(
      r.evals.map((e) => e.state),
      ['passed', 'passed'],
    )
  })

  test('a failed result keeps the error name so assemble can classify without sniffing', async () => {
    const { run } = project(['evals/a.eval.ts'])
    const { spawn } = fakeSpawn((ctl) => {
      ctl.emit({ t: 'collected', tests: [test0(0, 'a')] })
      if (ctl.init.select) {
        ctl.emit({
          t: 'result',
          index: 0,
          result: {
            state: 'failed',
            errors: [{ name: 'TimeoutError', message: 'Eval timed out after 1s' }],
            durationMs: 10,
          },
        })
        ctl.emit({ t: 'ready' })
      }
      ctl.emit({ t: 'done' })
      ctl.exit()
    })
    const r = await engine({ run }, spawn)
    assert.equal(r.evals[0]?.errorName, 'TimeoutError')
    assert.equal(r.evals[0]?.errors[0], 'Eval timed out after 1s')
  })

  test('a cancel reaches running workers, and files not started never start', async () => {
    const { run } = project(['evals/a.eval.ts', 'evals/b.eval.ts'])
    const one = { ...run, concurrency: 1 }
    let cancel = () => {}
    const tests = { 'a.eval.ts': [test0(0, 'a')], 'b.eval.ts': [test0(0, 'b')] }
    const { spawn, spawned } = fakeSpawn((ctl) => {
      const name = basename(ctl.init.file) as 'a.eval.ts'
      ctl.emit({ t: 'collected', tests: tests[name] })
      if (!ctl.init.select) {
        ctl.emit({ t: 'done' })
        ctl.exit()
        return
      }
      cancel()
      const wait = setInterval(() => {
        if (!ctl.received.some((m) => m.t === 'cancel')) return
        clearInterval(wait)
        ctl.emit({
          t: 'result',
          index: 0,
          result: {
            state: 'failed',
            errors: [{ name: 'Error', message: 'aborted' }],
            durationMs: 0,
          },
        })
        ctl.emit({ t: 'meta', index: 0, meta: { late: true } as never })
        ctl.emit({ t: 'meta', index: 5, meta: {} as never })
        ctl.emit({ t: 'done' })
        ctl.exit()
      }, 2)
    })
    const r = await engine({ run: one, onCancellable: (c) => (cancel = c) }, spawn)
    assert.equal(r.cancelled, true)
    assert.deepEqual(
      spawned.filter((s) => !s.endsWith('collect')),
      ['a.eval.ts:0'],
    )
    // As under Vitest, the attempt the cancel cut short is skipped; its record says aborted.
    assert.deepEqual(
      r.evals.map((e) => [e.id, e.state, e.meta]),
      [['evals/a.eval.ts › a', 'skipped', { late: true }]],
    )
    assert.match(r.evals[0]?.formattedErrors[0] ?? '', /Error.*: aborted/)
  })

  test('a cancel before any worker starts starts none', async () => {
    const { run } = project(['evals/a.eval.ts'])
    const { spawn, spawned } = fakeSpawn(passing({ 'a.eval.ts': [test0(0, 'a')] }))
    const r = await engine({ run, onCancellable: (cancel) => cancel() }, spawn)
    assert.equal(r.cancelled, true)
    assert.deepEqual(spawned, ['a.eval.ts:collect'])
    assert.deepEqual(r.evals, [])
  })

  test('a cancel while a worker starts reaches it right after init', async () => {
    const { run } = project(['evals/a.eval.ts'])
    const { spawn } = fakeSpawn(
      (ctl) => {
        ctl.emit({ t: 'collected', tests: [test0(0, 'a')] })
        if (!ctl.init.select) {
          ctl.emit({ t: 'done' })
          ctl.exit()
          return
        }
        setTimeout(() => {
          assert.deepEqual(
            ctl.received.map((m) => m.t),
            ['cancel', 'init', 'cancel'],
          )
          ctl.emit({
            t: 'result',
            index: 0,
            result: { state: 'skipped', errors: [], durationMs: 0 },
          })
          ctl.emit({ t: 'done' })
          ctl.exit()
        }, 1)
      },
      { helloAfter: (n) => (n === 1 ? 0 : 30) },
    )
    const r = await engine({ run, onCancellable: (cancel) => setTimeout(cancel, 10) }, spawn)
    assert.equal(r.cancelled, true)
    assert.deepEqual(
      r.evals.map((e) => e.state),
      ['skipped'],
    )
  })

  test('a worker that dies mid-file fails its unfinished attempts and reports why', async () => {
    const { run } = project(['evals/a.eval.ts'])
    const tests = [
      test0(0, 'done first'),
      test0(1, 'unfinished'),
      test0(2, 'skipped', { mode: 'skip' }),
      test0(3, 'filtered out'),
    ]
    const events: EsEvent[] = []
    const { spawn } = fakeSpawn((ctl) => {
      ctl.emit({ t: 'collected', tests })
      if (!ctl.init.select) {
        ctl.emit({ t: 'done' })
        ctl.exit()
        return
      }
      ctl.emit({ t: 'result', index: 0, result: { state: 'passed', errors: [], durationMs: 0 } })
      ctl.exit({ code: null, signal: 'SIGKILL' })
    })
    const r = await engine(
      { run, filters: ['done first', 'unfinished', 'skipped'], onEvent: (e) => events.push(e) },
      spawn,
    )
    const why = 'The worker running evals/a.eval.ts exited unexpectedly (signal SIGKILL)'
    assert.deepEqual(r.unhandledErrors, [why])
    assert.deepEqual(
      r.evals.map((e) => [e.name, e.state, e.errors]),
      [
        ['done first', 'passed', []],
        ['unfinished', 'failed', [why]],
        ['skipped', 'skipped', []],
      ],
    )
    assert.equal(events.filter((e) => e.type === 'eval-end').length, 2)
  })

  test('a file that fails to load on its second pass, or a worker that fails its handshake, is reported', async () => {
    const { run } = project(['evals/a.eval.ts'])
    const { spawn } = fakeSpawn((ctl) => {
      if (!ctl.init.select) ctl.emit({ t: 'collected', tests: [test0(0, 'a')] })
      else ctl.emit({ t: 'load-error', error: { message: 'changed on disk' } })
      ctl.emit({ t: 'done' })
      ctl.exit()
    })
    const r = await engine({ run }, spawn)
    assert.deepEqual(r.unhandledErrors, ['evals/a.eval.ts: changed on disk'])
    assert.deepEqual(r.evals, [])

    let spawns = 0
    const flaky: Spawn = (entry, cwd) => {
      const pass = ++spawns
      return fakeSpawn(
        passing({ 'a.eval.ts': [test0(0, 'a')] }),
        pass === 1 ? {} : { hello: false },
      ).spawn(entry, cwd)
    }
    await assert.rejects(engine({ run }, flaky), /exited before it started/)
  })
})
