// The behaviors every Runner has, wherever it runs commands. A runner's own test file calls
// runnerConformance() with a way to make a fresh one; reeval runs it on its runners too.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { type Proc, type Runner, withFallbacks } from '../src/runner.ts'

export type MakeRunner = () => Promise<Runner>

export async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true })
  return out + decoder.decode()
}

/** Runs a command to completion, returning its exit, stdout and stderr. */
export async function run(runner: Runner, cmd: string | string[], options = {}) {
  const proc = runner.spawn(cmd, options)
  const [stdout, stderr, exit] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
    proc.exited,
  ])
  return { ...exit, stdout, stderr }
}

/** Reads stdout until it holds a whole line, leaving the rest unread. */
async function firstLine(proc: Proc): Promise<string> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (!out.includes('\n')) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  return out.split('\n')[0] ?? ''
}

const alive = async (runner: Runner, pid: string) =>
  (await run(runner, ['sh', '-c', 'kill -0 "$1" 2>/dev/null', 'sh', pid])).code === 0

/**
 * Runs `fn`, failing on an uncaught exception or unhandled rejection it caused, which would
 * otherwise crash the process that drives the runner.
 */
async function noStrayErrors(fn: () => Promise<void>) {
  const stray: unknown[] = []
  const record = (error: unknown) => void stray.push(error)
  process.on('uncaughtException', record)
  process.on('unhandledRejection', record)
  try {
    await fn()
    await new Promise((r) => setTimeout(r, 100))
  } finally {
    process.off('uncaughtException', record)
    process.off('unhandledRejection', record)
  }
  assert.deepEqual(stray, [])
}

/** The runner without copies of its own, so `withFallbacks` gives the tar ones. */
const tarOnly = (base: Runner): Runner => ({
  info: () => base.info(),
  spawn: (cmd, options) => base.spawn(cmd, options),
  readFile: (path) => base.readFile(path),
  writeFile: (path, data, options) => base.writeFile(path, data, options),
  close: () => base.close(),
})

/** Polls until `check` holds, failing with `what` after the deadline. */
async function eventually(what: string, check: () => Promise<boolean>, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs
  while (!(await check())) {
    if (Date.now() > until) assert.fail(`${what} (after ${deadlineMs / 1000}s)`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

export function runnerConformance(name: string, make: MakeRunner) {
  describe(`${name} runner conformance`, () => {
    const opened: Runner[] = []
    const fresh = async () => {
      const runner = await make()
      opened.push(runner)
      return runner
    }
    const hostDirs: string[] = []
    const hostDir = async () => {
      const dir = await mkdtemp(join(tmpdir(), 'reeval-agents-runner-'))
      hostDirs.push(dir)
      return dir
    }
    after(async () => {
      await Promise.all(opened.map((r) => r.close()))
      await Promise.all(hostDirs.map((d) => rm(d, { recursive: true, force: true })))
    })

    test('info names a platform and absolute paths', async () => {
      const info = await (await fresh()).info()
      assert.match(info.platform, /^(linux|darwin)-(x64|arm64)$/)
      if (info.platform.startsWith('linux')) assert.match(info.libc ?? '', /^(glibc|musl)$/)
      for (const path of [info.home, info.cwd, info.shell]) assert.match(path, /^\//)
    })

    test('an argv runs as is and a string through the shell', async () => {
      const runner = await fresh()
      assert.deepEqual(await run(runner, ['printf', '%s|', 'a b', '$HOME']), {
        code: 0,
        signal: null,
        stdout: 'a b|$HOME|',
        stderr: '',
      })
      const shell = await run(runner, 'echo $((1 + 2)) && echo oops >&2')
      assert.equal(shell.stdout, '3\n')
      assert.equal(shell.stderr, 'oops\n')
    })

    test('stdin, env and cwd reach the command', async () => {
      const runner = await fresh()
      const info = await runner.info()
      const proc = runner.spawn(['cat'], { stdin: 'pipe' })
      await proc.write('one ')
      await proc.write(new TextEncoder().encode('two'))
      await proc.end()
      assert.equal(await text(proc.stdout), 'one two')
      assert.equal((await proc.exited).code, 0)

      assert.equal(
        (await run(runner, 'printf %s "$GREETING"', { env: { GREETING: 'hi' } })).stdout,
        'hi',
      )
      assert.equal(
        (await run(runner, 'pwd -P')).stdout.trim(),
        (await run(runner, ['sh', '-c', `cd "${info.cwd}" && pwd -P`])).stdout.trim(),
      )
      await runner.writeFile('nested/dir/.keep', '')
      const nested = await run(runner, 'pwd -P', { cwd: 'nested/dir' })
      assert.match(nested.stdout.trim(), /\/nested\/dir$/)
      assert.equal((await run(runner, 'printf x', { stdin: 'ignore' })).stdout, 'x')
    })

    test('an exit code, and the signal that ended a process', async () => {
      const runner = await fresh()
      assert.deepEqual(await run(runner, 'exit 7'), {
        code: 7,
        signal: null,
        stdout: '',
        stderr: '',
      })
      const proc = runner.spawn(['sleep', '30'])
      await proc.kill()
      assert.deepEqual(await proc.exited, { code: null, signal: 'SIGTERM' })
      await proc.kill('SIGKILL')
    })

    test('a kill takes the whole process tree', async () => {
      const runner = await fresh()
      const proc = runner.spawn('sleep 300 & echo $!; wait')
      const child = await firstLine(proc)
      assert.match(child, /^\d+$/)
      assert.ok(await alive(runner, child))
      await proc.kill('SIGKILL')
      await proc.exited
      await eventually(
        `sleep ${child} outlived the kill`,
        async () => !(await alive(runner, child)),
      )
    })

    test('an aborted signal kills the process tree', async () => {
      const runner = await fresh()
      const controller = new AbortController()
      const proc = runner.spawn('sleep 300 & echo $!; wait', { signal: controller.signal })
      const child = await firstLine(proc)
      controller.abort()
      assert.equal((await proc.exited).signal, 'SIGKILL')
      await eventually(
        `sleep ${child} outlived the abort`,
        async () => !(await alive(runner, child)),
      )
    })

    test('files round-trip as bytes, with their mode', async () => {
      const runner = await fresh()
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
      await runner.writeFile('bin/all-bytes', bytes)
      assert.deepEqual(await runner.readFile('bin/all-bytes'), bytes)
      const info = await runner.info()
      assert.deepEqual(await runner.readFile(`${info.cwd}/bin/all-bytes`), bytes)
      assert.equal(await runner.readFile('bin/missing'), null)

      await runner.writeFile('bin/hello', '#!/bin/sh\necho hello\n', { mode: 0o755 })
      assert.equal((await run(runner, './bin/hello')).stdout, 'hello\n')
      await runner.writeFile('bin/hello', 'replaced')
      assert.equal(
        new TextDecoder().decode((await runner.readFile('bin/hello')) ?? undefined),
        'replaced',
      )
    })

    for (const via of ['its own', 'the tar fallback'] as const) {
      test(`upload and download round-trip a directory, through ${via}`, async () => {
        const base = await fresh()
        const runner = withFallbacks(via === 'its own' ? base : tarOnly(base))
        const from = await hostDir()
        await mkdir(join(from, 'deep', 'er'), { recursive: true })
        await writeFile(join(from, 'top.txt'), 'top')
        await writeFile(
          join(from, 'deep', 'er', 'bytes'),
          Uint8Array.from({ length: 256 }, (_, i) => i),
        )
        await symlink('../top.txt', join(from, 'deep', 'link'))
        await runner.upload(from, 'uploaded')
        assert.equal(
          new TextDecoder().decode((await runner.readFile('uploaded/top.txt')) ?? undefined),
          'top',
        )

        const to = join(await hostDir(), 'back')
        await runner.download('uploaded', to)
        assert.equal(await readFile(join(to, 'top.txt'), 'utf8'), 'top')
        assert.deepEqual(
          new Uint8Array(await readFile(join(to, 'deep', 'er', 'bytes'))),
          Uint8Array.from({ length: 256 }, (_, i) => i),
        )
        assert.equal((await run(runner, ['readlink', 'uploaded/deep/link'])).stdout, '../top.txt\n')
        assert.equal(await readlink(join(to, 'deep', 'link')), '../top.txt')
      })

      test(`an upload that can't land rejects with its reason, through ${via}`, async () => {
        const base = await fresh()
        const runner = withFallbacks(via === 'its own' ? base : tarOnly(base))
        const from = await hostDir()
        await writeFile(
          join(from, 'file'),
          Uint8Array.from({ length: 1 << 20 }, (_, i) => i % 251),
        )
        await runner.writeFile('blocker', 'a file, not a directory')
        await noStrayErrors(async () => {
          await assert.rejects(runner.upload(from, 'blocker/sub'), (error: Error) => {
            assert.match(error.message, /blocker/)
            assert.doesNotMatch(error.message, /EPIPE|reset by peer/)
            return true
          })
          await assert.rejects(runner.download('missing', join(from, 'back')), /missing/)
        })
      })
    }

    test('writing to a process that exits rejects, and nothing else fails', async () => {
      const runner = await fresh()
      const proc = runner.spawn('sleep 0.1; exit 1', { stdin: 'pipe' })
      await noStrayErrors(async () => {
        await assert.rejects(async () => {
          for (let i = 0; i < 50; i++) await proc.write(new Uint8Array(1 << 20))
        })
        assert.equal((await proc.exited).code, 1)
      })
    })

    test('a kill after the process exited and left nothing behind is a no-op', async () => {
      const runner = await fresh()
      const proc = runner.spawn(['true'])
      assert.equal((await proc.exited).code, 0)
      await proc.kill()
      await proc.kill('SIGKILL')
      assert.equal((await run(runner, ['true'])).code, 0)
    })

    test('close kills what it started and can be called again', async () => {
      const runner = await make()
      const proc = runner.spawn('sleep 300 & wait')
      const background = runner.spawn('sleep 300 &')
      assert.equal((await background.exited).code, 0)
      await runner.close()
      assert.equal((await proc.exited).signal, 'SIGKILL')
      await runner.close()
      assert.throws(() => runner.spawn(['true']))
    })
  })
}
