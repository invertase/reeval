// The main process's side of one worker: a fresh `es __worker` per eval file, in its own process
// group (a terminal's Ctrl-C reaches the CLI, which cancels over IPC), with its output piped
// rather than mixed into ES's own.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { UsageError } from '../errors.ts'
import { DIST_DIR, esCommand } from '../root.ts'
import { type FromWorker, PROTOCOL, type ToWorker } from './protocol.ts'

export type Exit = { code: number | null; signal: NodeJS.Signals | null }

export type WorkerProcess = {
  send(message: ToWorker): void
  onMessage(listener: (message: FromWorker) => void): void
  /** Text the worker wrote to stdout or stderr outside ES's console routing. */
  onOutput(listener: (stream: 'stdout' | 'stderr', text: string) => void): void
  exited: Promise<Exit>
  kill(): void
}

/** Starts a worker from `entry`, an ES's `dist/cli.js`, in `cwd`. */
export type Spawn = (entry: string, cwd: string) => WorkerProcess

export const forkWorker: Spawn = (entry, cwd) => {
  const [command, ...args] = esCommand(entry, ['__worker'], ['--enable-source-maps'])
  const child = spawn(command, args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  })
  // Done once it has exited and its last messages are in. On Windows 'exit' can come first; they
  // all arrive before 'disconnect', which Windows doesn't always send, so at most a second later.
  // Not 'close', which also waits for stdout and stderr: pipes a process it started may hold.
  const disconnected = new Promise<void>((resolve) => child.once('disconnect', resolve))
  const exited = new Promise<Exit>((resolve) =>
    child.once('exit', (code, signal) => {
      const done = () => {
        clearTimeout(grace)
        resolve({ code, signal })
      }
      const grace = setTimeout(done, 1000)
      void disconnected.then(done)
    }),
  )
  // A message sent after the worker exited has nowhere to go; its exit is handled instead.
  child.on('error', () => {})
  return {
    send: (message) => {
      if (child.connected) child.send(message, () => {})
    },
    onMessage: (listener) => child.on('message', (m) => listener(m as FromWorker)),
    onOutput: (listener) => {
      child.stdout?.setEncoding('utf8').on('data', (text: string) => listener('stdout', text))
      child.stderr?.setEncoding('utf8').on('data', (text: string) => listener('stderr', text))
    },
    exited,
    kill: () => child.kill('SIGKILL'),
  }
}

/**
 * The `dist/cli.js` of the ES the project resolves, so the worker and the eval files share one
 * copy of ES; ES's own when the project resolves none.
 */
export function workerEntry(root: string, names: readonly string[]): string {
  for (const name of names) {
    let manifest: string
    try {
      manifest = createRequire(join(root, 'noop.js')).resolve(`${name}/package.json`)
    } catch {
      continue
    }
    const entry = join(dirname(manifest), 'dist', 'cli.js')
    if (existsSync(entry)) return entry
  }
  return join(DIST_DIR, 'cli.js')
}

/** Resolves once the worker has said hello in this engine's protocol. */
export function handshake(worker: WorkerProcess, entry: string): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onMessage((message) => {
      if (message.t !== 'hello') return
      if (message.protocol === PROTOCOL) resolve()
      else {
        worker.kill()
        reject(
          new UsageError(
            `The ES at ${dirname(dirname(entry))} runs eval files with engine protocol ${message.protocol}, but this es speaks ${PROTOCOL}. Run the project's own es, e.g. npx es.`,
          ),
        )
      }
    })
    void worker.exited.then((exit) =>
      reject(new Error(`the worker exited before it started (${describeExit(exit)})`)),
    )
  })
}

export const describeExit = ({ code, signal }: Exit): string =>
  signal ? `signal ${signal}` : `exit code ${code}`

/** Runs `task` for each item, at most `limit` at once, while `go()` says so. */
export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  go: () => boolean = () => true,
): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length && go()) await task(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}
