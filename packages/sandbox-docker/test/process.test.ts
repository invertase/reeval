import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run, windowsSpawn } from '../src/process.ts'

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
  // Node on both levels, so the pid the grandchild writes is the OS's on Windows too.
  const pidFile = join(mkdtempSync(join(tmpdir(), 'es-process-')), 'grandchild')
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000)`
  const child = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 30_000)`
  const controller = new AbortController()
  const running = run(process.execPath, ['-e', child], { signal: controller.signal })
  let pid = 0
  for (let i = 0; i < 400 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 25))
    pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0
  }
  assert.ok(pid > 0 && alive(pid), 'the grandchild started')
  controller.abort(new Error('stop'))
  await assert.rejects(running, /stop/)
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(alive(pid), false, 'the grandchild was killed too')
})

test('on Windows, a .exe runs as itself and a .cmd script through cmd.exe, arguments escaped', () => {
  const env = {
    Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  }
  const files = new Set([
    'C:\\Program Files\\nodejs\\npm',
    'C:\\Program Files\\nodejs\\npm.cmd',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'D:\\app\\node_modules\\.bin\\es.cmd',
  ])
  const exists = (path: string) => files.has(path)
  assert.deepEqual(windowsSpawn('git', ['status', '-z'], env, exists), {
    file: 'C:\\Program Files\\Git\\cmd\\git.exe',
    args: ['status', '-z'],
    verbatim: false,
  })
  assert.deepEqual(
    windowsSpawn('npm', ['pack', '@acme/skills@1.2.3', 'a b', 'x"y\\'], env, exists),
    {
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"C:\\Program^ Files\\nodejs\\npm.cmd ^"pack^" ^"@acme/skills@1.2.3^" ^"a^ b^" ^"x\\^"y\\\\^""',
      ],
      verbatim: true,
    },
  )
  // A node_modules/.bin shim hands its arguments to cmd.exe again, so they're escaped twice.
  assert.equal(
    windowsSpawn('D:\\app\\node_modules\\.bin\\es', ['a&b'], env, exists).args[3],
    '"D:\\app\\node_modules\\.bin\\es.cmd ^^^"a^^^&b^^^""',
  )
  assert.equal(
    windowsSpawn('nope', [], env, exists).file,
    'nope',
    'not found: spawn reports ENOENT',
  )
})
