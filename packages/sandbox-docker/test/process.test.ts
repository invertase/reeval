import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../src/process.ts'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('run collects text or Buffer output, env and stdin', async () => {
  const text = await run('sh', ['-c', 'printf "%s:" "$X"; cat; echo oops >&2; exit 3'], {
    env: { X: 'x' },
    input: 'in',
  })
  assert.deepEqual(text, { exitCode: 3, stdout: 'x:in', stderr: 'oops\n' })
  const bytes = await run('printf', ['\\377\\000'], { binary: true })
  assert.deepEqual([...bytes.stdout], [0xff, 0])
})

test('aborting kills the whole process group, grandchildren included', async () => {
  const controller = new AbortController()
  const running = run('sh', ['-c', 'sleep 30 & wait'], { signal: controller.signal })
  await new Promise((r) => setTimeout(r, 300))
  const { stdout } = await run('pgrep', ['-f', '^sleep 30$'])
  const grandchild = Number(stdout.trim().split('\n').at(-1))
  assert.ok(grandchild > 0 && alive(grandchild))
  controller.abort(new Error('stop'))
  await assert.rejects(running, /stop/)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(alive(grandchild), false, 'the sleep under sh -c was killed too')
})
