import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { local } from '../src/local.ts'
import type { Runner } from '../src/runner.ts'
import { runnerSession } from '../src/runner-session.ts'
import { text } from './runner-conformance.ts'

const cleanup: (() => Promise<unknown>)[] = []
after(() => Promise.all(cleanup.map((c) => c())))

async function localRunner() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'reeval-agents-session-')))
  const runner = local({ cwd })
  cleanup.push(
    () => runner.close(),
    () => rm(cwd, { recursive: true, force: true }),
  )
  return { cwd, runner }
}

test('the session starts in the runner cwd and runs commands through it', async () => {
  const { cwd, runner } = await localRunner()
  const session = await runnerSession(runner, { id: 's1' })
  assert.equal(session.id, 's1')
  assert.equal(session.defaultWorkingDirectory, cwd)
  assert.match(session.description, new RegExp(cwd))
  assert.deepEqual(await session.run({ command: 'pwd -P; echo err >&2; exit 3' }), {
    exitCode: 3,
    stdout: `${cwd}\n`,
    stderr: 'err\n',
  })
  await session.writeTextFile({ path: 'sub/.keep', content: '' })
  const sub = await session.run({
    command: 'pwd -P && printf %s "$X"',
    workingDirectory: 'sub',
    env: { X: 'y' },
  })
  assert.equal(sub.stdout, `${cwd}/sub\ny`)
})

test('spawn pipes stdin, and kill or abort ends the process', async () => {
  const { runner } = await localRunner()
  const session = await runnerSession(runner)
  const cat = await session.spawn({ command: 'cat', stdin: true })
  const writer = cat.stdin.getWriter()
  await writer.write(new TextEncoder().encode('piped'))
  await writer.close()
  assert.equal(await text(cat.stdout), 'piped')
  assert.deepEqual(await cat.wait(), { exitCode: 0 })

  const sleeper = await session.spawn({ command: 'sleep 30' })
  assert.equal('stdin' in sleeper, false)
  await sleeper.kill()
  assert.deepEqual(await sleeper.wait(), { exitCode: 137 })

  const controller = new AbortController()
  const aborted = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal })
  controller.abort(new Error('stop'))
  await assert.rejects(async () => aborted.wait(), /stop/)
  await assert.rejects(
    async () => session.run({ command: 'true', abortSignal: controller.signal }),
    /stop/,
  )
})

test('files read and write as text, bytes and streams', async () => {
  const { cwd, runner } = await localRunner()
  const session = await runnerSession(runner)
  await session.writeTextFile({ path: 'a/lines.txt', content: 'one\ntwo\nthree\nfour' })
  assert.equal(await session.readTextFile({ path: 'a/lines.txt' }), 'one\ntwo\nthree\nfour')
  assert.equal(
    await session.readTextFile({ path: `${cwd}/a/lines.txt`, startLine: 2, endLine: 3 }),
    'two\nthree',
  )
  assert.equal(
    await session.readTextFile({ path: 'a/lines.txt', startLine: 3, endLine: 99 }),
    'three\nfour',
  )
  assert.equal(await session.readTextFile({ path: 'a/missing' }), null)

  const bytes = Uint8Array.from({ length: 256 }, (_, i) => 255 - i)
  await session.writeFile({
    path: 'b/stream',
    content: new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, 100))
        c.enqueue(bytes.slice(100))
        c.close()
      },
    }),
  })
  assert.deepEqual(await session.readBinaryFile({ path: 'b/stream' }), bytes)
  const stream = await session.readFile({ path: 'b/stream' })
  assert.ok(stream)
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), bytes)
  assert.equal(await session.readFile({ path: 'b/missing' }), null)

  await session.writeTextFile({ path: 'latin1', content: 'café', encoding: 'latin1' })
  assert.deepEqual(
    await session.readBinaryFile({ path: 'latin1' }),
    Uint8Array.from([0x63, 0x61, 0x66, 0xe9]),
  )
  assert.equal(await session.readTextFile({ path: 'latin1', encoding: 'latin1' }), 'café')
})

test('stat, listDirectory and deleteFile', async () => {
  const { cwd, runner } = await localRunner()
  const session = await runnerSession(runner)
  await session.writeTextFile({ path: 'd/file', content: '12345' })
  await session.writeTextFile({ path: 'd/sub/.hidden', content: '' })
  await session.writeTextFile({ path: 'd/new\nline', content: '' })
  await symlink('file', join(cwd, 'd', 'link'))

  assert.deepEqual(await session.stat({ path: 'd/file' }), { type: 'file', size: 5 })
  assert.equal((await session.stat({ path: 'd' }))?.type, 'directory')
  assert.equal(await session.stat({ path: 'nope' }), null)

  const entries = await session.listDirectory({ path: 'd' })
  assert.deepEqual(
    entries?.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { type: 'file', name: 'file' },
      { type: 'symlink', name: 'link' },
      { type: 'file', name: 'new\nline' },
      { type: 'directory', name: 'sub' },
    ],
  )
  assert.deepEqual(await session.listDirectory({ path: 'd/sub' }), [
    { type: 'file', name: '.hidden' },
  ])
  assert.equal(await session.listDirectory({ path: 'nope' }), null)
  await assert.rejects(async () => session.listDirectory({ path: 'd/file' }), /not a directory/)

  assert.equal(await session.deleteFile({ path: 'd/link' }), true)
  assert.deepEqual(await session.stat({ path: 'd/file' }), { type: 'file', size: 5 })
  assert.equal(await session.deleteFile({ path: 'd/file' }), true)
  assert.equal(await session.deleteFile({ path: 'd/file' }), false)
  await assert.rejects(async () => session.deleteFile({ path: 'd/sub' }), /is a directory/)
})

test('ports resolve through forwardPort, and stop closes the forwards', async () => {
  const server = createServer((_, res) => res.end('served'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(() => new Promise((r) => server.close(r)))
  const port = (server.address() as { port: number }).port
  const { runner } = await localRunner()
  let closed = 0
  const counted: Runner = {
    ...runner,
    forwardPort: async (p) => ({ host: '127.0.0.1', port: p, close: async () => void closed++ }),
  }
  const session = await runnerSession(counted, { ports: [port] })
  assert.deepEqual(session.ports, [port])
  const endpoint = await session.getPortEndpoint({ port })
  assert.equal(endpoint.url, `http://127.0.0.1:${port}`)
  assert.equal(await (await fetch(endpoint.url)).text(), 'served')
  assert.equal(await session.getPortUrl({ port, protocol: 'ws' }), `ws://127.0.0.1:${port}`)
  await session.stop()
  assert.equal(closed, 1)
  await session.destroy()
  assert.equal(closed, 1)
  assert.equal((await session.run({ command: 'echo still' })).stdout, 'still\n')

  const { forwardPort: _, ...noPorts } = runner
  const without = await runnerSession(noPorts as Runner)
  await assert.rejects(async () => without.getPortEndpoint({ port }), /can't forward port/)
})

test('the runner network passes through untouched, and restricted drops it', async () => {
  const { runner } = await localRunner()
  const plain = await runnerSession(runner)
  assert.equal(plain.setNetworkPolicy, undefined)
  assert.equal(plain.addRequestTransformations, undefined)
  assert.equal(plain.setRequestTransformations, undefined)

  const calls: string[] = []
  const network: Runner['network'] = {
    setNetworkPolicy: async () => void calls.push('policy'),
    addRequestTransformations: async () => void calls.push('add'),
  }
  const brokered = await runnerSession({ ...runner, network })
  assert.equal(brokered.setNetworkPolicy, network.setNetworkPolicy)
  assert.equal(brokered.addRequestTransformations, network.addRequestTransformations)
  assert.equal(brokered.setRequestTransformations, undefined)
  await brokered.setNetworkPolicy?.('deny-all' as never)
  await brokered.addRequestTransformations?.([])
  assert.deepEqual(calls, ['policy', 'add'])

  const restricted = brokered.restricted()
  for (const key of [
    'setNetworkPolicy',
    'addRequestTransformations',
    'stop',
    'destroy',
    'getPortEndpoint',
  ]) {
    assert.equal(key in restricted, false, key)
  }
  assert.equal((await restricted.run({ command: 'echo ok' })).stdout, 'ok\n')
})
