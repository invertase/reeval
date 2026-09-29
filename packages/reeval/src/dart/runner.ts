// Starts a Dart runner and talks to it: reeval listens on a loopback port, starts the runner with
// the address and a one-time token, and accepts the one connection that says hello with both.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { UsageError } from '../errors.ts'
import { type FromRunner, RUNNER_PROTOCOL, type ToRunner } from './protocol.ts'
import type { RunnerCommand } from './project.ts'

export type DartRunner = {
  send(message: ToRunner): void
  /** Every message after hello, in order. */
  onMessage(listener: (message: FromRunner) => void): void
  /** Resolves with the next message of type `t` (or a `load-error`, which rejects). */
  next<T extends FromRunner['t']>(t: T): Promise<Extract<FromRunner, { t: T }>>
  /** The runner exited or closed its connection; the reason names its exit code and stderr. */
  onGone(listener: (reason: string) => void): void
  hello: Extract<FromRunner, { t: 'hello' }>
  close(): void
}

export class RunnerLoadError extends Error {}

const STDERR_KEPT = 4_000

export async function startDartRunner(command: RunnerCommand, cwd: string): Promise<DartRunner> {
  const token = randomBytes(16).toString('hex')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as { port: number }
  const [cmd = 'dart', ...args] = command
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, REEVAL_RUNNER: `127.0.0.1:${port}`, REEVAL_RUNNER_TOKEN: token },
    stdio: ['ignore', 'inherit', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT)
  })
  const exited = new Promise<string>((resolve) => {
    child.once('error', (error) => resolve(`it didn't start: ${error.message}`))
    child.once('exit', (code, signal) =>
      resolve(`it exited (${signal ?? `code ${code}`})${stderr.trim() ? `:\n${stderr.trim()}` : ''}`),
    )
  })

  const connected = new Promise<{ socket: Socket; hello: Extract<FromRunner, { t: 'hello' }> }>(
    (resolve) => {
      server.on('connection', (socket) => {
        const lines = createInterface({ input: socket })
        lines.once('line', (line) => {
          let hello: FromRunner | undefined
          try {
            hello = JSON.parse(line) as FromRunner
          } catch {}
          if (hello?.t !== 'hello' || hello.token !== token) return void socket.destroy()
          lines.removeAllListeners('line')
          lines.close()
          server.close()
          resolve({ socket, hello })
        })
      })
    },
  )
  const first = await Promise.race([connected, exited])
  if (typeof first === 'string') {
    server.close()
    throw new RunnerLoadError(`The Dart runner stopped before it connected: ${first}`)
  }
  const { socket, hello } = first
  if (hello.protocol !== RUNNER_PROTOCOL) {
    child.kill()
    throw new UsageError(
      `package:reeval ${hello.version} speaks runner protocol ${hello.protocol}, but this reeval speaks ${RUNNER_PROTOCOL}. Update one to match the other (dart pub upgrade reeval, or reinstall reeval).`,
    )
  }

  const listeners: ((message: FromRunner) => void)[] = []
  const gone: ((reason: string) => void)[] = []
  let goneReason: string | undefined
  const lines = createInterface({ input: socket })
  lines.on('line', (line) => {
    if (!line) return
    const message = JSON.parse(line) as FromRunner
    for (const listener of [...listeners]) listener(message)
  })
  socket.on('error', () => {})
  const markGone = async () => {
    if (goneReason !== undefined) return
    goneReason = await Promise.race([
      exited,
      new Promise<string>((r) => setTimeout(() => r('it closed its connection'), 1_000).unref()),
    ])
    for (const listener of gone) listener(goneReason)
  }
  socket.once('close', markGone)
  void exited.then(markGone)

  return {
    hello,
    send: (message) => void socket.write(`${JSON.stringify(message)}\n`),
    onMessage: (listener) => void listeners.push(listener),
    onGone: (listener) => {
      if (goneReason !== undefined) listener(goneReason)
      else gone.push(listener)
    },
    next: (t) =>
      new Promise((resolve, reject) => {
        const listener = (message: FromRunner) => {
          if (message.t !== t && message.t !== 'load-error') return
          listeners.splice(listeners.indexOf(listener), 1)
          if (message.t === 'load-error') reject(errorFrom(message.error))
          else resolve(message as Extract<FromRunner, { t: typeof t }>)
        }
        listeners.push(listener)
        gone.push((reason) => reject(new RunnerLoadError(`The Dart runner stopped: ${reason}`)))
      }),
    close: () => {
      socket.end()
      setTimeout(() => child.kill(), 2_000).unref()
    },
  }
}

/** An error from the runner as a JS error the engine prints and records like a TypeScript one. */
export function errorFrom(wire: {
  name: string
  message: string
  stack?: string
  expected?: unknown
  actual?: unknown
}): Error {
  const error = new Error(wire.message) as Error & { expected?: unknown; actual?: unknown }
  error.name = wire.name
  error.stack = wire.stack ?? `${wire.name}: ${wire.message}`
  if ('expected' in wire && 'actual' in wire) {
    error.expected = wire.expected
    error.actual = wire.actual
  }
  return error
}
