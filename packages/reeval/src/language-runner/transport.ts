// Starts a language SDK runner and talks to it over its stdin and stdout, one JSON message a line.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { UsageError } from '../errors.ts'
import {
  type FromRunner,
  isFromRunner,
  isSessionFrom,
  RUNNER_PROTOCOL,
  type SessionFromRunner,
  type ToRunner,
  type WireError,
} from './protocol.ts'

export type RunnerCommand = readonly [command: string, ...args: string[]]

export type LanguageRunner = {
  send(message: ToRunner): void
  onMessage(listener: (message: FromRunner) => void): void
  nextSession<T extends SessionFromRunner['t']>(t: T): Promise<Extract<SessionFromRunner, { t: T }>>
  onGone(listener: (reason: string) => void): void
  hello: Extract<SessionFromRunner, { t: 'hello' }>
  close(): void
}

export class RunnerLoadError extends Error {}

const STDERR_KEPT = 4_000

/** A runner's stdout line: a message, or `undefined` for output that isn't one. */
function parsed(line: string): FromRunner | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(line)
    return isFromRunner(value) ? value : undefined
  } catch {
    return undefined
  }
}

export async function startLanguageRunner(
  command: RunnerCommand,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LanguageRunner> {
  const [cmd = '', ...args] = command
  const child = spawn(cmd, args, {
    cwd,
    env: { ...env, REEVAL_RUNNER: 'stdio', REEVAL_RUNNER_PROTOCOL: String(RUNNER_PROTOCOL) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // A runner whose body left threads behind may outlive its stdin closing; it never outlives reeval.
  const killOnExit = () => child.kill()
  process.on('exit', killOnExit)
  child.once('exit', () => process.off('exit', killOnExit))
  child.once('error', () => process.off('exit', killOnExit))
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT)
  })
  child.stdin.on('error', () => {})
  const exited = new Promise<string>((resolve) => {
    child.once('error', (error) => resolve(`it didn't start: ${error.message}`))
    child.once('exit', (code, signal) =>
      resolve(
        `it exited (${signal ?? `code ${code}`})${stderr.trim() ? `:\n${stderr.trim()}` : ''}`,
      ),
    )
  })

  const listeners: ((message: FromRunner) => void)[] = []
  const lines = createInterface({ input: child.stdout })
  // Anything on stdout that isn't a message (a stray write the SDK didn't route) is shown, not parsed.
  lines.on('line', (line) => {
    const message = parsed(line)
    if (!message) return void (line && process.stderr.write(`${line}\n`))
    for (const listener of [...listeners]) listener(message)
  })

  const greeted = new Promise<Extract<SessionFromRunner, { t: 'hello' }>>((resolve) => {
    const listener = (message: FromRunner) => {
      if (!isSessionFrom(message) || message.t !== 'hello') return
      listeners.splice(listeners.indexOf(listener), 1)
      resolve(message)
    }
    listeners.push(listener)
  })
  const first = await Promise.race([greeted, exited])
  if (typeof first === 'string') {
    throw new RunnerLoadError(
      `The language runner stopped before it said hello: ${first}\nAn SDK that speaks an older runner protocol than this reeval's (${RUNNER_PROTOCOL}) stops like this: update the SDK to the version that matches reeval.`,
    )
  }
  const hello = first
  if (hello.protocol !== RUNNER_PROTOCOL) {
    child.kill()
    throw new UsageError(
      `${hello.sdk} ${hello.version} speaks runner protocol ${hello.protocol}, but this reeval speaks ${RUNNER_PROTOCOL}. Use the SDK version that matches reeval.`,
    )
  }

  const gone: ((reason: string) => void)[] = []
  let goneReason: string | undefined
  const markGone = async () => {
    if (goneReason !== undefined) return
    goneReason = await Promise.race([
      exited,
      new Promise<string>((r) => setTimeout(() => r('it closed its stdout'), 1_000).unref()),
    ])
    for (const listener of gone) listener(goneReason)
  }
  lines.once('close', markGone)
  void exited.then(markGone)

  return {
    hello,
    send: (message) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
    },
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
      child.stdin.end()
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

export { isRunnerAttemptDone, isRunnerAttemptRequest, isSessionFrom } from './protocol.ts'
