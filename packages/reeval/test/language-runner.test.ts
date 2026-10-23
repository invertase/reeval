import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RUNNER_PROTOCOL } from '../src/language-runner/protocol.ts'
import {
  projectUsesUv,
  REEVAL_PYTHON_MODULE,
  resolvePythonRunnerCommand,
} from '../src/language-runner/python-runner.ts'
import { type RunnerCommand, startLanguageRunner } from '../src/language-runner/transport.ts'

test('resolvePythonRunnerCommand prefers REEVAL_PYTHON', () => {
  const prev = process.env.REEVAL_PYTHON
  process.env.REEVAL_PYTHON = '/custom/python'
  try {
    assert.deepEqual(resolvePythonRunnerCommand('/any'), [
      '/custom/python',
      '-m',
      REEVAL_PYTHON_MODULE,
    ])
  } finally {
    if (prev === undefined) delete process.env.REEVAL_PYTHON
    else process.env.REEVAL_PYTHON = prev
  }
})

test('resolvePythonRunnerCommand uses .venv python when present', () => {
  const prev = process.env.REEVAL_PYTHON
  delete process.env.REEVAL_PYTHON
  const root = mkdtempSync(join(tmpdir(), 'reeval-py-'))
  const venvBin = join(root, '.venv', 'bin')
  mkdirSync(venvBin, { recursive: true })
  writeFileSync(join(venvBin, 'python'), '#!/bin/sh\n', { mode: 0o755 })
  try {
    const cmd = resolvePythonRunnerCommand(root)
    assert.equal(cmd[0], join(root, '.venv', 'bin', 'python'))
    assert.deepEqual(cmd.slice(1), ['-m', REEVAL_PYTHON_MODULE])
  } finally {
    if (prev === undefined) delete process.env.REEVAL_PYTHON
    else process.env.REEVAL_PYTHON = prev
  }
})

/** A runner as a Node script: `body` runs with `send(message)` and `lines` (what reeval sent). */
function fakeRunner(body: string): RunnerCommand {
  const script = `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
    const lines = require('node:readline').createInterface({ input: process.stdin })
    ${body}
  `
  return [process.execPath, '-e', script]
}

test('a runner talks over its stdin and stdout, and stray stdout is not a message', async () => {
  const runner = await startLanguageRunner(
    fakeRunner(`
      if (process.env.REEVAL_RUNNER !== 'stdio') process.exit(3)
      if (process.env.REEVAL_RUNNER_PROTOCOL !== '${RUNNER_PROTOCOL}') process.exit(5)
      console.log('not a message')
      send({ t: 'hello', protocol: ${RUNNER_PROTOCOL}, sdk: 'fake', version: '1', runtime: 'node' })
      lines.on('line', (line) => {
        const m = JSON.parse(line)
        send({ t: 'declared', file: m.file, tree: { children: [] } })
      })
    `),
    tmpdir(),
  )
  assert.equal(runner.hello.sdk, 'fake')
  runner.send({ t: 'collect', file: 'evals/a.eval.fake' })
  const declared = await runner.nextSession('declared')
  assert.equal(declared.file, 'evals/a.eval.fake')
  const gone = new Promise<string>((resolve) => runner.onGone(resolve))
  runner.close()
  assert.match(await gone, /exited|closed/)
})

test('a JSON object on stdout that is no message is shown, not taken as one', async () => {
  const runner = await startLanguageRunner(
    fakeRunner(`
      send({ t: 'hello', protocol: ${RUNNER_PROTOCOL}, sdk: 'fake', version: '1', runtime: 'node' })
      lines.on('line', () => {
        send({ type: 'done', attempt: 'a#1' })
        send({ id: '1', call: 'exec', key: 'k' })
        send({ t: 'log', text: 'no stream' })
        send({ type: 'done', key: 'k' })
      })
    `),
    tmpdir(),
  )
  const seen: unknown[] = []
  runner.onMessage((message) => seen.push(message))
  runner.send({ t: 'collect', file: 'x' })
  await new Promise<void>((resolve) => runner.onMessage((message) => 'key' in message && resolve()))
  runner.close()
  assert.deepEqual(seen, [{ type: 'done', key: 'k' }])
})

test('a runner that ignores its stdin closing is killed when reeval exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-runner-orphan-'))
  const host = join(dir, 'host.ts')
  const runner = fakeRunner(`
    send({ t: 'hello', protocol: ${RUNNER_PROTOCOL}, sdk: 'fake', version: '1', runtime: String(process.pid) })
    setInterval(() => {}, 1_000)
  `)
  writeFileSync(
    host,
    `import { startLanguageRunner } from ${JSON.stringify(new URL('../src/language-runner/transport.ts', import.meta.url).href)}
const runner = await startLanguageRunner(${JSON.stringify(runner)}, ${JSON.stringify(dir)})
console.log(runner.hello.runtime)
runner.close()
process.exit(0)
`,
  )
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', host],
    {
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const pid = Number(result.stdout.trim())
  assert.ok(pid > 0, result.stdout)
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100))
  const orphaned = alive()
  if (orphaned) process.kill(pid, 'SIGKILL')
  assert.equal(orphaned, false, 'the runner outlived reeval')
})

test('a runner on another protocol, or one that stops before hello, says why', async () => {
  await assert.rejects(
    startLanguageRunner(
      fakeRunner(`send({ t: 'hello', protocol: 1, sdk: 'fake', version: '0.1', runtime: 'node' })`),
      tmpdir(),
    ),
    new RegExp(`fake 0\\.1 speaks runner protocol 1, but this reeval speaks ${RUNNER_PROTOCOL}`),
  )
  await assert.rejects(
    startLanguageRunner(fakeRunner(`console.error('no SDK here'); process.exit(4)`), tmpdir()),
    /stopped before it said hello: it exited \(code 4\):\nno SDK here\nAn SDK that speaks an older runner protocol/,
  )
})

test('projectUsesUv is true when pyproject.toml or uv.lock exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-py-'))
  assert.equal(projectUsesUv(root), false)
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\n')
  assert.equal(projectUsesUv(root), true)
})
