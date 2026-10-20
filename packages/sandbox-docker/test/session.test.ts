// Session behaviours in a real container: what an abort or kill leaves
// running, and what a create leaves behind.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import { after, describe, test } from 'node:test'
import { PROXY_PORT } from '../src/egress/gateway.ts'
import { BRIDGE_PORT, DEFAULT_IMAGE } from '../src/image.ts'
import type { DockerSession } from '../src/session.ts'
import { CLI, createSession, REQUIRE_ENGINE } from './engine.ts'

const dockerReady = (() => {
  try {
    execFileSync(CLI, ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const requireDocker = REQUIRE_ENGINE
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
  execFileSync(CLI, ['ps', '-aq', '--filter', `label=ai.reeval.test=${value}`], {
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
          const s = await createSession({
            image: DEFAULT_IMAGE,
            labels: { 'ai.reeval.test': label },
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
            `docker rm -f $(docker ps -aq --filter label=ai.reeval.test=${label})`,
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
    const s = await createSession({
      image: DEFAULT_IMAGE,
      labels: { 'ai.reeval.test': label },
    })
    await assert.rejects(
      eventually('expected to time out', async () => labelled(label) === '', 1000),
      /expected to time out/,
    )
    await s.destroy()
  })
})

/** A GET that resolves with the body, or rejects on an error or after `ms` without an answer. */
const get = (url: string, ms: number) =>
  new Promise<string>((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (d) => {
        body += d
      })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    })
    req.setTimeout(ms, () => req.destroy(new Error(`no answer within ${ms}ms`)))
    req.once('error', reject)
  })

describe('the gateway when its forwarder dies', { skip, timeout: 60_000 }, () => {
  test('the session reports it, and ports fail fast with the reason', async () => {
    const s = await createSession({
      image: DEFAULT_IMAGE,
      labels: { 'ai.reeval.test': 'forwarder' },
      egress: true,
    })
    try {
      const server = await s.spawn({
        command: `node -e "require('http').createServer((q, r) => r.end('bridge ok')).listen(${BRIDGE_PORT}, '0.0.0.0')"`,
      })
      const { url } = await s.getPortEndpoint({ port: BRIDGE_PORT, protocol: 'http' })
      await eventually('the bridge answers', () =>
        get(url, 1000).then(
          (b) => b === 'bridge ok',
          () => false,
        ),
      )
      // The forwarder is the one process whose command line has the proxy port. It runs as root,
      // out of the sandbox user's reach, so kill it as root.
      const pattern = `[${String(PROXY_PORT)[0]}]${String(PROXY_PORT).slice(1)}`
      const killed = spawnSync(CLI, [
        'exec',
        '--user',
        '0:0',
        s.id,
        'pkill',
        '-KILL',
        '-f',
        pattern,
      ])
      assert.equal(killed.status, 0, 'pkill found the forwarder')
      await eventually(
        'the session reports the gateway stopped',
        async () => s.egress?.active === false,
      )
      assert.match(s.egress?.active === false ? s.egress.reason : '', /forwarder exited/)
      await assert.rejects(
        get(url, 3000),
        (error: Error) => !/no answer within/.test(error.message),
      )
      await assert.rejects(
        s.getPortEndpoint({ port: BRIDGE_PORT, protocol: 'http' }),
        /isn't reachable: the egress gateway stopped: the forwarder exited/,
      )
      await server.kill()
    } finally {
      await s.destroy()
    }
  })
})

describe('exec in a container', { skip, timeout: 60_000 }, () => {
  const sessions: DockerSession[] = []
  const open = async () => {
    const s = await createSession({
      image: DEFAULT_IMAGE,
      labels: { 'ai.reeval.test': 'session' },
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
