// The sandbox primitives every fixture relies on, checked from outside against both sandboxes:
// if exec, readFile, writeFile or `~/` were broken, a fixture's own checks could lie.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, test } from 'node:test'
import { DEFAULT_IMAGE } from '@evalsuite/sandbox-docker'
import { createSandbox, type Sandbox } from '../src/sandbox/index.ts'
import type { SandboxDescriptor } from '../src/types.ts'
import { tempDir } from './helpers.ts'

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const requireDocker = process.env.ES_TEST_REQUIRE_DOCKER === '1'

const kinds: Array<{ name: string; descriptor: () => SandboxDescriptor; skip: string | false }> = [
  { name: 'fake', descriptor: () => ({ kind: 'fake', dir: tempDir('contract') }), skip: false },
  {
    name: 'docker',
    descriptor: () => ({ kind: 'docker' }),
    skip: !dockerReady && !requireDocker && `needs Docker and ${DEFAULT_IMAGE}`,
  },
]

for (const kind of kinds) {
  describe(`sandbox contract: ${kind.name}`, { skip: kind.skip, timeout: 120_000 }, () => {
    let box: Sandbox | undefined
    const sandbox = async () => {
      box ??= await createSandbox(kind.descriptor(), {
        runId: `contract-${process.pid}`,
        timeoutMs: 120_000,
        signal: new AbortController().signal,
        env: { ES_CONTRACT_VAR: 'from-the-sandbox' },
        egress: { policy: 'allow-all', auto: [] },
      })
      return box
    }
    after(() => box?.destroy())

    test('writeFile then exec reads it, in the workspace and in ~/', async () => {
      const s = await sandbox()
      await s.writeFile('nested/dir/w.txt', 'workspace\n')
      await s.writeFile('~/.config/es/h.txt', 'home\n')
      assert.equal((await s.exec('cat nested/dir/w.txt')).stdout, 'workspace\n')
      assert.equal((await s.exec('cat ~/.config/es/h.txt')).stdout, 'home\n')
      assert.equal((await s.exec('printf %s "$HOME"')).stdout, s.home)
    })

    test('exec writes, then readFile reads it, in the workspace and in ~/', async () => {
      const s = await sandbox()
      await s.exec('mkdir -p out && printf "a\\nb" > out/r.txt && printf x > ~/r.txt')
      assert.equal(await s.readFile('out/r.txt'), 'a\nb')
      assert.equal(await s.readFile('~/r.txt'), 'x')
      assert.equal(await s.readFile('r.txt'), null, "a ~/ file isn't in the workspace")
      assert.equal(await s.readFile('no/such/file'), null)
    })

    test('exec: exit codes, stderr, cwd and per-command env over the sandbox env', async () => {
      const s = await sandbox()
      const failed = await s.exec('echo out; echo err >&2; exit 7')
      assert.deepEqual(failed, { exitCode: 7, stdout: 'out\n', stderr: 'err\n' })
      assert.equal((await s.exec('pwd')).stdout.trim(), s.workdir)
      await s.exec('mkdir -p sub')
      assert.equal((await s.exec('pwd', { cwd: 'sub' })).stdout.trim(), `${s.workdir}/sub`)
      assert.equal((await s.exec('printf %s "$ES_CONTRACT_VAR"')).stdout, 'from-the-sandbox')
      const over = await s.exec('printf %s "$ES_CONTRACT_VAR"', {
        env: { ES_CONTRACT_VAR: 'from-the-command' },
      })
      assert.equal(over.stdout, 'from-the-command')
      assert.equal((await s.exec('printf %s "$ES_CONTRACT_VAR"')).stdout, 'from-the-sandbox')
    })

    test('writeFile replaces a file whole', async () => {
      const s = await sandbox()
      await s.writeFile('replace.txt', 'a much longer first version\n')
      await s.writeFile('replace.txt', 'short\n')
      assert.equal(await s.readFile('replace.txt'), 'short\n')
    })
  })
}
