import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { docker } from '../src/docker/index.ts'
import { run, runnerConformance } from './runner-conformance.ts'

const IMAGE = 'node:24-slim'

function dockerReady(): string | null {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 })
  } catch {
    return 'Docker is not running'
  }
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' })
  } catch {
    execFileSync('docker', ['pull', '--quiet', IMAGE], { stdio: 'ignore', timeout: 300_000 })
  }
  return null
}

const skip = dockerReady()
if (skip && process.env.REEVAL_TEST_REQUIRE_DOCKER === '1') {
  throw new Error(`REEVAL_TEST_REQUIRE_DOCKER=1, but ${skip}`)
}

describe('docker()', { skip: skip ?? false }, () => {
  const dirs: string[] = []
  after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

  runnerConformance('docker()', () => docker({ image: IMAGE }))

  test('docker() works in a host directory it mounts, as the user it names', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'reeval-agents-docker-')))
    dirs.push(dir)
    await writeFile(join(dir, 'from-host'), 'hi')
    const runner = await docker({ image: IMAGE, mount: dir, workdir: '/work', user: 'node' })
    try {
      const info = await runner.info()
      assert.deepEqual(
        {
          platform: info.platform.startsWith('linux-'),
          cwd: info.cwd,
          user: info.user,
          home: info.home,
        },
        { platform: true, cwd: '/work', user: 'node', home: '/home/node' },
      )
      assert.equal((await run(runner, 'cat from-host')).stdout, 'hi')
      await runner.writeFile('from-box', 'back')
      assert.equal(await readFile(join(dir, 'from-box'), 'utf8'), 'back')
    } finally {
      await runner.close()
    }
  })

  test("docker() sets its env and each command's on what it runs", async () => {
    const runner = await docker({ image: IMAGE, env: { BASE: 'b' } })
    try {
      const out = await run(runner, 'printf %s/%s "$BASE" "$KEY"', { env: { KEY: 'k-value' } })
      assert.equal(out.stdout, 'b/k-value')
    } finally {
      await runner.close()
    }
  })

  test('docker() forwards a port it published, and refuses one it did not', async () => {
    const runner = await docker({ image: IMAGE, ports: [8123] })
    try {
      const server = runner.spawn([
        'node',
        '-e',
        "require('http').createServer((q, s) => s.end('pong')).listen(8123, () => console.log('up'))",
      ])
      const reader = server.stdout.getReader()
      await reader.read()
      reader.releaseLock()
      const { host, port } = (await runner.forwardPort?.(8123)) ?? assert.fail('no forwardPort')
      assert.equal(await (await fetch(`http://${host}:${port}`)).text(), 'pong')
      await assert.rejects(runner.forwardPort?.(9999) ?? Promise.resolve(), /ports option/)
      await server.kill()
    } finally {
      await runner.close()
    }
  })

  test('docker() removes its container on close unless keep', async () => {
    const name = `reeval-agents-test-${process.pid}`
    const kept = await docker({ image: IMAGE, name, keep: true })
    await kept.close()
    execFileSync('docker', ['inspect', name], { stdio: 'ignore' })
    execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' })
    const gone = await docker({ image: IMAGE, name })
    await gone.close()
    assert.throws(() => execFileSync('docker', ['inspect', name], { stdio: 'ignore' }))
  })
})
