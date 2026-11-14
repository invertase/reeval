import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { local } from '../src/local.ts'
import { run, runnerConformance, text } from './runner-conformance.ts'

const dirs: string[] = []
const workspace = async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reeval-agents-local-')))
  dirs.push(dir)
  return dir
}
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

runnerConformance('local()', async () => local({ cwd: await workspace() }))

test('local() resolves its workspace and reports this machine', async () => {
  const cwd = await workspace()
  const runner = local({ cwd: join(cwd, '.') })
  const info = await runner.info()
  assert.equal(info.cwd, cwd)
  assert.equal(info.platform, `${process.platform}-${process.arch}`)
  assert.equal(info.shell, '/bin/sh')
  await runner.close()
})

test('local() passes this environment on unless inherit is false', async () => {
  process.env.REEVAL_AGENTS_LOCAL_TEST = 'from-host'
  try {
    const cwd = await workspace()
    const inherited = local({ cwd, env: { EXTRA: 'x' } })
    assert.equal(
      (await run(inherited, 'printf %s/%s "$REEVAL_AGENTS_LOCAL_TEST" "$EXTRA"')).stdout,
      'from-host/x',
    )
    const isolated = local({ cwd, env: { EXTRA: 'x' }, inherit: false })
    const out = await run(isolated, 'printf %s/%s/%s "$REEVAL_AGENTS_LOCAL_TEST" "$EXTRA" "$HOME"')
    assert.equal(out.stdout, `/x/${(await isolated.info()).home}`)
    assert.equal((await run(isolated, 'command -v sh')).code, 0)
    await Promise.all([inherited.close(), isolated.close()])
  } finally {
    delete process.env.REEVAL_AGENTS_LOCAL_TEST
  }
})

test('local() close kills a process its command left in the background', async () => {
  const runner = local({ cwd: await workspace() })
  const proc = runner.spawn('sleep 300 > /dev/null 2>&1 & echo $!')
  const pid = Number((await text(proc.stdout)).trim())
  assert.equal((await proc.exited).code, 0)
  assert.doesNotThrow(() => process.kill(pid, 0))
  await runner.close()
  const until = Date.now() + 5000
  while (Date.now() < until) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`sleep ${pid} outlived close()`)
})

test('local() never signals a group once it is empty, since its id can be reused', async (t) => {
  const runner = local({ cwd: await workspace() })
  const done = runner.spawn(['true'])
  await done.exited
  const lingering = runner.spawn('sleep 300 > /dev/null 2>&1 &')
  await lingering.exited
  const signaled: number[] = []
  const kill = process.kill.bind(process)
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (signal !== 0) signaled.push(pid)
    return kill(pid, signal)
  })
  await done.kill('SIGKILL')
  await runner.close()
  assert.equal(signaled.length, 1, 'only the group with a sleep still in it')
  assert.ok((signaled[0] ?? 0) < 0)
})

test('local() refuses writing to stdin it did not pipe', async () => {
  const runner = local({ cwd: await workspace() })
  const proc = runner.spawn(['true'])
  await assert.rejects(proc.write('x'), /stdin isn't piped/)
  await proc.exited
  await runner.close()
})
