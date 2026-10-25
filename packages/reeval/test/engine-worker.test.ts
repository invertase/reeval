// A worker (engine/worker.ts) driven in-process over a fake channel: hello, collecting, running a
// selection with leases over the channel, load errors, cancel, orphaning and unhandled errors.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type FromWorker, PROTOCOL, type ToWorker } from '../src/engine/protocol.ts'
import {
  declareHarnesses,
  getRunContext,
  registerGroup,
  registerTest,
} from '../src/engine/runtime.ts'
import { type Channel, startWorker } from '../src/engine/worker.ts'
import type { RunContext } from '../src/types.ts'
import { tempDir } from './helpers.ts'

// Eval files load through jiti, not this process's own module graph, so they reach the runtime
// the worker installed through a global.
Object.assign(globalThis, {
  __es: { registerTest, registerGroup, getRunContext, declareHarnesses },
})

/** A channel whose main process closes it once `done` arrives, as forkWorker's does. */
function fakeChannel({ closeAfterDone = true } = {}) {
  const sent: FromWorker[] = []
  let deliver: (m: ToWorker) => void = () => {}
  let disconnect = () => {}
  const exits: number[] = []
  let exited = () => {}
  const exit = new Promise<void>((resolve) => {
    exited = resolve
  })
  const channel: Channel = {
    send: (message) => {
      sent.push(message)
      if (message.t === 'done' && closeAfterDone) setTimeout(() => disconnect(), 1)
    },
    onMessage: (listener) => {
      deliver = listener
    },
    onDisconnect: (listener) => {
      disconnect = listener
    },
    exit: (code) => {
      exits.push(code)
      exited()
    },
  }
  return {
    channel,
    sent,
    exits,
    exit,
    send: (m: ToWorker) => deliver(m),
    disconnect: () => disconnect(),
    types: () => sent.map((m) => m.t),
  }
}

function evalFile(body: string): { root: string; file: string; run: RunContext } {
  const root = tempDir('worker')
  mkdirSync(join(root, 'evals'), { recursive: true })
  const file = join(root, 'evals/w.eval.ts')
  writeFileSync(file, `const { registerTest, registerGroup } = (globalThis as any).__es\n${body}\n`)
  const run = {
    config: { root },
    stagingDir: join(root, '.reeval/staging/run'),
  } as unknown as RunContext
  return { root, file, run }
}

const until = async (check: () => boolean) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('startWorker', () => {
  test('says hello, collects, reports the tests with their attempts and harnesses, and exits', async () => {
    const c = fakeChannel()
    startWorker(c.channel)
    assert.deepEqual(c.sent[0], { t: 'hello', protocol: PROTOCOL })
    const { file, run } = evalFile(`
if (!(globalThis as any).__es.getRunContext().config.root) throw new Error('no run context')
registerGroup('g', 'run', () => {
  registerTest('a [x#1]', { mode: 'run', attempt: { name: 'a' } }, async () => {})
})
registerTest('todo', { mode: 'todo' }, async () => {})
const { declareHarnesses } = (globalThis as any).__es
declareHarnesses(['a', 'b'])
declareHarnesses(['b', 'c'])
`)
    c.send({ t: 'init', run, file, select: null })
    await c.exit
    assert.deepEqual(c.types(), ['hello', 'collected', 'done'])
    assert.deepEqual(c.sent[1], {
      t: 'collected',
      tests: [
        { index: 0, name: 'a [x#1]', groups: ['g'], mode: 'run', attempt: { name: 'a' } },
        { index: 1, name: 'todo', groups: [], mode: 'todo' },
      ],
      harnesses: ['a', 'b', 'c'],
    })
    assert.deepEqual(c.exits, [0])
  })

  test('runs a selection, asking the main process for leases over the channel', async () => {
    const c = fakeChannel()
    startWorker(c.channel)
    const { file, run } = evalFile(`
const gate = () => ({ limits: { attempts: 1 }, rank: { eval: 'e', file: 'f', order: 0, n: 1, cell: 0 } })
registerTest('gated', { mode: 'run', gate }, async (h) => {
  console.log('from gated')
  h.progress({ kind: 'sandbox' })
  h.debug({ phase: 'x' })
})
registerTest('not selected', { mode: 'run' }, async () => { throw new Error('ran') })
`)
    c.send({ t: 'init', run, file, select: [0] })
    await until(() => c.sent.some((m) => m.t === 'request'))
    const request = c.sent.find((m) => m.t === 'request') as { id: string }
    c.send({ t: 'grant', id: request.id })
    await c.exit
    assert.deepEqual(c.types(), [
      'hello',
      'collected',
      'request',
      'result',
      'ready',
      'start',
      'log',
      'progress',
      'debug',
      'release',
      'result',
      'done',
    ])
    assert.deepEqual(
      c.sent.filter((m) => m.t === 'result').map((m) => [m.index, m.result.state]),
      [
        [1, 'skipped'],
        [0, 'passed'],
      ],
    )
    assert.equal((c.sent.find((m) => m.t === 'log') as { index?: number }).index, 0)
  })

  test('logs outside an attempt go to the file; a record after a timeout follows its result', async () => {
    const c = fakeChannel()
    startWorker(c.channel)
    const { file, run } = evalFile(`
console.log('at the top')
registerTest('slow', { mode: 'run', timeout: 20 }, async (h) => {
  await new Promise((resolve) => h.signal.addEventListener('abort', resolve))
  await new Promise((resolve) => setTimeout(resolve, 10))
  h.setMeta({ late: true })
})
`)
    c.send({ t: 'init', run, file, select: [0] })
    await c.exit
    assert.deepEqual(
      c.sent.find((m) => m.t === 'log'),
      {
        t: 'log',
        at: (c.sent.find((m) => m.t === 'log') as { at: number }).at,
        stream: 'stdout',
        text: 'at the top\n',
      },
    )
    assert.deepEqual(
      c.sent.find((m) => m.t === 'meta'),
      { t: 'meta', index: 0, meta: { late: true } },
    )
  })

  test('after done, waits for the main process to close the channel before it exits', async () => {
    const c = fakeChannel({ closeAfterDone: false })
    startWorker(c.channel)
    const { file, run } = evalFile(`registerTest('a', { mode: 'run' }, async () => {})`)
    c.send({ t: 'init', run, file, select: null })
    await until(() => c.sent.some((m) => m.t === 'done'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(c.exits, [])
    c.disconnect()
    await c.exit
    assert.deepEqual(c.exits, [0])
  })

  test("a file that doesn't load reports why, then exits", async () => {
    const c = fakeChannel()
    startWorker(c.channel)
    const { file, run } = evalFile("throw new Error('boom at import')")
    c.send({ t: 'init', run, file, select: [0] })
    await c.exit
    assert.deepEqual(c.types(), ['hello', 'load-error', 'done'])
    assert.equal((c.sent[1] as { error: { message: string } }).error.message, 'boom at import')
  })

  test('a cancel aborts the running attempts; an orphaned worker cancels, finishes and exits', async () => {
    const c = fakeChannel()
    startWorker(c.channel)
    const { file, run } = evalFile(`
registerTest('waits', { mode: 'run' }, async (h) => {
  await new Promise((resolve) => h.signal.addEventListener('abort', resolve))
  h.signal.throwIfAborted()
})
`)
    c.send({ t: 'init', run, file, select: [0] })
    await until(() => c.sent.some((m) => m.t === 'start'))
    c.send({ t: 'cancel' })
    await c.exit
    const cancelled = c.sent.find(
      (m): m is Extract<FromWorker, { t: 'result' }> => m.t === 'result',
    )
    assert.equal(cancelled?.result.state, 'failed')
    assert.equal(cancelled?.result.errors[0]?.name, 'AbortError')
    assert.equal(cancelled?.result.errors[0]?.message, 'The run was cancelled')

    const orphan = fakeChannel()
    startWorker(orphan.channel)
    const second = evalFile(`
registerTest('waits', { mode: 'run' }, async (h) => {
  await new Promise((resolve) => h.signal.addEventListener('abort', resolve))
})
`)
    orphan.send({ t: 'init', run: second.run, file: second.file, select: [0] })
    await until(() => orphan.sent.some((m) => m.t === 'start'))
    orphan.disconnect()
    await orphan.exit
    assert.deepEqual(orphan.exits.slice(0, 1), [0])
  })

  for (const select of [null, [0]]) {
    test(`an orphan whose file never finishes loading exits at once (select ${JSON.stringify(select)})`, async () => {
      const c = fakeChannel()
      startWorker(c.channel)
      const { file, run } = evalFile(`
;(globalThis as any).__loading = true
await new Promise(() => {})
registerTest('never', { mode: 'run' }, async () => {})
`)
      c.send({ t: 'init', run, file, select })
      await until(() => (globalThis as { __loading?: boolean }).__loading === true)
      delete (globalThis as { __loading?: boolean }).__loading
      c.disconnect()
      await c.exit
      assert.deepEqual(c.exits, [0])
      assert.deepEqual(c.types(), ['hello'])
    })
  }

  test('an orphan with nothing running exits at once, and unhandled errors are reported', async () => {
    const c = fakeChannel()
    const worker = startWorker(c.channel)
    worker.unhandled(new Error('stray rejection'))
    const sent = c.sent[1] as { t: string; error: { name: string; message: string } }
    assert.deepEqual(
      [sent.t, sent.error.name, sent.error.message],
      ['unhandled', 'Error', 'stray rejection'],
    )
    c.disconnect()
    await c.exit
    assert.deepEqual(c.exits, [0])
  })
})
