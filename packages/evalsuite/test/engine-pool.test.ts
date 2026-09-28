// The main process's side of a worker (engine/pool.ts): forking, the handshake, finding the
// project's own worker entry, and running files a few at a time.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  describeExit,
  eachLimited,
  forkWorker,
  handshake,
  workerEntry,
} from '../src/engine/pool.ts'
import { PROTOCOL } from '../src/engine/protocol.ts'
import { UsageError } from '../src/errors.ts'
import { DIST_DIR } from '../src/root.ts'
import { tempDir } from './helpers.ts'

function script(body: string): string {
  const file = join(tempDir('pool'), 'worker.mjs')
  writeFileSync(file, body)
  return file
}

describe('forkWorker and handshake', () => {
  test('a worker says hello in our protocol, talks both ways, writes output and exits', async () => {
    const entry = script(`
process.send({ t: 'hello', protocol: ${PROTOCOL} })
process.on('message', (m) => {
  console.log('stdout text')
  console.error('stderr text')
  process.send({ t: 'done', echo: m.t, argv: process.argv.slice(2) }, () => process.exit(0))
})
`)
    const worker = forkWorker(entry, tempDir('cwd'))
    const messages: unknown[] = []
    const output: string[] = []
    worker.onMessage((m) => messages.push(m))
    worker.onOutput((stream, text) => output.push(`${stream}:${text}`))
    await handshake(worker, entry)
    worker.send({ t: 'cancel' })
    assert.deepEqual(await worker.exited, { code: 0, signal: null })
    worker.send({ t: 'cancel' })
    assert.deepEqual(messages.at(-1), { t: 'done', echo: 'cancel', argv: ['__worker'] })
    assert.deepEqual(output.sort(), ['stderr:stderr text\n', 'stdout:stdout text\n'])
  })

  test('a worker in another protocol is refused and killed', async () => {
    const entry = script(
      `process.send({ t: 'hello', protocol: ${PROTOCOL + 1} }); setInterval(() => {}, 1000)`,
    )
    const worker = forkWorker(entry, tempDir('cwd'))
    await assert.rejects(handshake(worker, entry), (e: Error) => {
      assert.ok(e instanceof UsageError)
      assert.match(
        e.message,
        new RegExp(
          `engine protocol ${PROTOCOL + 1}, but this es speaks ${PROTOCOL}\\. Run the project's own es`,
        ),
      )
      return true
    })
    assert.equal((await worker.exited).signal, 'SIGKILL')
  })

  test('a worker that dies before hello fails the handshake; other messages wait for hello', async () => {
    const entry = script(`process.send({ t: 'log', text: 'early' }, () => process.exit(7))`)
    const worker = forkWorker(entry, tempDir('cwd'))
    await assert.rejects(
      handshake(worker, entry),
      /the worker exited before it started \(exit code 7\)/,
    )
    assert.equal(describeExit({ code: null, signal: 'SIGTERM' }), 'signal SIGTERM')
  })
})

test("es __worker, which isn't a command, refuses to start without the engine", () => {
  const r = spawnSync(process.execPath, [join(DIST_DIR, 'cli.js'), '__worker'], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /es __worker is the process ES starts for each eval file/)
})

describe('workerEntry', () => {
  test("the project's own copy of ES, when it has a CLI; else this ES's", () => {
    const root = tempDir('entry')
    const pkg = join(root, 'node_modules/evalsuite')
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'evalsuite', exports: { './package.json': './package.json' } }),
    )
    assert.equal(workerEntry(root, ['@invertase/foobar', 'evalsuite']), join(DIST_DIR, 'cli.js'))
    writeFileSync(join(pkg, 'dist/cli.js'), '')
    assert.equal(workerEntry(root, ['@invertase/foobar', 'evalsuite']), join(pkg, 'dist/cli.js'))
    assert.equal(workerEntry(tempDir('none'), ['evalsuite']), join(DIST_DIR, 'cli.js'))
  })
})

describe('eachLimited', () => {
  test('runs at most the limit at once, in order, and stops when told', async () => {
    let running = 0
    let most = 0
    const seen: number[] = []
    await eachLimited([1, 2, 3, 4, 5], 2, async (n) => {
      running++
      most = Math.max(most, running)
      seen.push(n)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
    })
    assert.equal(most, 2)
    assert.deepEqual(seen, [1, 2, 3, 4, 5])
    const stopped: number[] = []
    await eachLimited(
      [1, 2, 3],
      1,
      async (n) => void stopped.push(n),
      () => stopped.length < 2,
    )
    assert.deepEqual(stopped, [1, 2])
    await eachLimited([], 4, async () => assert.fail('nothing to run'))
  })
})
