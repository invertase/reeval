// Starts a language SDK runner and talks to it over loopback TCP + NDJSON + one-time token.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { UsageError } from '../errors.ts'
import {
  type FromRunner,
  isAttemptDone,
  isSessionFrom,
  RUNNER_PROTOCOL,
  type SessionFromRunner,
  type ToRunner,
} from './protocol.ts'

export type RunnerCommand = readonly [command: string, ...args: string[]]

export type LanguageRunner = {
  send(message: ToRunner): void
  onMessage(listener: (message: FromRunner) => void): void
  nextSession<T extends SessionFromRunner['t']>(
    t: T,
  ): Promise<Extract<SessionFromRunner, { t: T }>>
  onGone(listener: (reason: string) => void): void
  hello: Extract<SessionFromRunner, { t: 'hello' }>
  close(): void
}

export class RunnerLoadError extends Error {}

const STDERR_KEPT = 4_000

export async function startLanguageRunner(
  command: RunnerCommand,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LanguageRunner> {
  const token = randomBytes(16).toString('hex')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as { port: number }
  const [cmd = '', ...args] = command
  const child = spawn(cmd, args, {
    cwd,
    env: { ...env, REEVAL_RUNNER: `127.0.0.1:${port}`, REEVAL_RUNNER_TOKEN: token },
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
      resolve(
        `it exited (${signal ?? `code ${code}`})${stderr.trim() ? `:\n${stderr.trim()}` : ''}`,
      ),
    )
  })

  const connected = new Promise<{
    socket: Socket
    hello: Extract<SessionFromRunner, { t: 'hello' }>
  }>((resolve) => {
    server.on('connection', (socket) => {
      const lines = createInterface({ input: socket })
      lines.once('line', (line) => {
        let hello: FromRunner | undefined
        try {
          hello = JSON.parse(line) as FromRunner
        } catch {}
        if (!isSessionFrom(hello!) || hello.t !== 'hello' || hello.token !== token)
          return void socket.destroy()
        lines.removeAllListeners('line')
        lines.close()
        server.close()
        resolve({ socket, hello })
      })
    })
  })
  const first = await Promise.race([connected, exited])
  if (typeof first === 'string') {
    server.close()
    throw new RunnerLoadError(`The language runner stopped before it connected: ${first}`)
  }
  const { socket, hello } = first
  if (hello.protocol !== RUNNER_PROTOCOL) {
    child.kill()
    throw new UsageError(
      `${hello.sdk} ${hello.version} speaks runner protocol ${hello.protocol}, but this reeval speaks ${RUNNER_PROTOCOL}. Update the SDK or reeval.`,
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
    nextSession: (t) =>
      new Promise((resolve, reject) => {
        const listener = (message: FromRunner) => {
          if (!isSessionFrom(message) || (message.t !== t && message.t !== 'load-error')) return
          listeners.splice(listeners.indexOf(listener), 1)
          if (message.t === 'load-error') reject(errorFrom(message.error))
          else resolve(message as Extract<SessionFromRunner, { t: typeof t }>)
        }
        listeners.push(listener)
        gone.push((reason) => reject(new RunnerLoadError(`The language runner stopped: ${reason}`)))
      }),
    close: () => {
      socket.end()
      setTimeout(() => child.kill(), 2_000).unref()
    },
  }
}

export function errorFrom(wire: WireError): Error {
  const error = new Error(wire.message) as Error & { expected?: unknown; actual?: unknown }
  error.name = wire.name
  error.stack = wire.stack ?? `${wire.name}: ${wire.message}`
  if ('expected' in wire && 'actual' in wire) {
    error.expected = wire.expected
    error.actual = wire.actual
  }
  return error
}

type WireError = import('./protocol.ts').WireError

export { isAttemptDone, isRunnerAttemptRequest, isSessionFrom } from './protocol.ts'
