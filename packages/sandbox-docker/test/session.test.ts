// Session behaviours in a real container (test-strategy §11.1–11.2): what an abort or kill leaves
// running, and what a create leaves behind.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, test } from 'node:test'
import { DEFAULT_IMAGE } from '../src/image.ts'
import { createDockerSession, type DockerSession } from '../src/session.ts'

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const requireDocker = process.env.ES_TEST_REQUIRE_DOCKER === '1'
const skip = !dockerReady && !requireDocker && `needs Docker and ${DEFAULT_IMAGE}`

/** Polls until `check` returns true, failing with `what` after the deadline. */
async function eventually(what: string, check: () => Promise<boolean>, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs
  while (!(await check())) {
    if (Date.now() > until) assert.fail(`${what} (after ${deadlineMs / 1000}s)`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Processes in the container whose command line contains `text`. */
async function processes(s: DockerSession, text: string): Promise<string> {
  // The bracket keeps this pgrep's own shell from matching.
  const pattern = `[${text[0]}]${text.slice(1)}`
  return (await s.run({ command: `pgrep -af '${pattern}' || true` })).stdout.trim()
}

let n = 0
/** A command unique to this test that runs until killed: a sleep with a distinct duration. */
const longCommand = () => `sleep 3000.${process.pid}${++n}`

/** Containers, running or not, with the test label `value`. */
const labelled = (value: string) =>
  execFileSync('docker', ['ps', '-aq', '--filter', `label=dev.evalsuite.test=${value}`], {
    encoding: 'utf8',
  }).trim()

describe('create and abort', { skip, timeout: 120_000 }, () => {
  // Across these delays the abort lands before, during and after `docker run`; wherever it lands,
  // nothing may be left behind.
  const delays = [0, 20, 50, 100, 150, 200, 300, 450, 700, 1000]

  test('an abort at any point while creating leaves no container', async () => {
    const outcomes: string[] = []
    const left: string[] = []
    await Promise.all(
      delays.map(async (ms) => {
        const label = `abort-${process.pid}-${ms}`
        const controller = new AbortController()
        setTimeout(() => controller.abort(new Error('stop')), ms)
        try {
          const s = await createDockerSession({
            image: DEFAULT_IMAGE,
            labels: { 'dev.evalsuite.test': label },
            abortSignal: controller.signal,
          })
          outcomes.push(`${ms}ms: created`)
          await s.destroy()
        } catch (error) {
          outcomes.push(`${ms}ms: ${(error as Error).message}`)
        }
        try {
          await eventually(`a container for ${label}`, async () => labelled(label) === '', 10_000)
        } catch {
          left.push(`${ms}ms`)
          execFileSync('sh', [
            '-c',
            `docker rm -f $(docker ps -aq --filter label=dev.evalsuite.test=${label})`,
          ])
        }
      }),
    )
    assert.deepEqual(
      left,
      [],
      `containers left after aborts at: ${left.join(', ')}\n${outcomes.join('\n')}`,
    )
  })

  test('the leak check sees a live container (twin: it can fail)', async () => {
    const label = `twin-${process.pid}`
    const s = await createDockerSession({
      image: DEFAULT_IMAGE,
      labels: { 'dev.evalsuite.test': label },
    })
    await assert.rejects(
      eventually('expected to time out', async () => labelled(label) === '', 1000),
      /expected to time out/,
    )
    await s.destroy()
  })
})

describe('exec in a container', { skip, timeout: 60_000 }, () => {
  const sessions: DockerSession[] = []
  const open = async () => {
    const s = await createDockerSession({
      image: DEFAULT_IMAGE,
      labels: { 'dev.evalsuite.test': 'session' },
    })
    sessions.push(s)
    return s
  }
  after(async () => {
    await Promise.all(sessions.map((s) => s.destroy()))
  })

  test('an aborted run() rejects with the reason, and its command stops in the container', async () => {
    const s = await open()
    const command = longCommand()
    const controller = new AbortController()
    const running = s.run({ command: `${command}; echo after`, abortSignal: controller.signal })
    await eventually(`${command} starts`, async () => (await processes(s, command)) !== '')
    controller.abort(new Error('stop'))
    await assert.rejects(running, /stop/)
    await eventually(
      `${command} is still running in the container after the abort`,
      async () => (await processes(s, command)) === '',
    )
  })

  test('spawn().kill() stops the command in the container', async () => {
    const s = await open()
    const command = longCommand()
    const child = await s.spawn({ command: `${command}; echo after` })
    await eventually(`${command} starts`, async () => (await processes(s, command)) !== '')
    await child.kill()
    await eventually(
      `${command} is still running in the container after kill()`,
      async () => (await processes(s, command)) === '',
    )
  })

  test('an aborted spawn() stops the command in the container', async () => {
    const s = await open()
    const command = longCommand()
    const controller = new AbortController()
    await s.spawn({ command, abortSignal: controller.signal })
    await eventually(`${command} starts`, async () => (await processes(s, command)) !== '')
    controller.abort()
    await eventually(
      `${command} is still running in the container after the abort`,
      async () => (await processes(s, command)) === '',
    )
  })

  test('the process check sees a running command (twin: it can fail)', async () => {
    const s = await open()
    const command = longCommand()
    const child = await s.spawn({ command })
    await eventually(`${command} starts`, async () => (await processes(s, command)) !== '')
    await assert.rejects(
      eventually('expected to time out', async () => (await processes(s, command)) === '', 1000),
      /expected to time out/,
    )
    await child.kill()
  })
})
