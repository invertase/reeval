// One eval file's worker: loads the file, reports what it declares, and with a selection, runs
// those attempts and exits. The main process starts a fresh one per file (./pool.ts), from the
// copy of reeval the project itself resolves, so the file registers with the reeval it imports.

import { loadEvalModule } from '../language-runner/load.ts'
import { evalMatchers } from '../matchers.ts'
import { useSchedulerChannel } from '../scheduler/client.ts'
import type { RunContext } from '../types.ts'
import { collect, collectingFile, registerGroup, registerTest } from './collector.ts'
import { extendExpect } from './expect.ts'
import { type FromWorker, PROTOCOL, type ToWorker } from './protocol.ts'
import { type Reporter, routeConsole, runTests, serializeError } from './run.ts'
import { useEngine } from './runtime.ts'

/** The worker's side of its IPC channel. */
export type Channel = {
  send(message: FromWorker): void
  onMessage(listener: (message: ToWorker) => void): void
  /** The main process closed the channel, after `done` or because it's gone. */
  onDisconnect(listener: () => void): void
  exit(code: number): void
}

export type Worker = {
  /** An unhandled rejection or uncaught exception anywhere in the worker. */
  unhandled(error: unknown): void
}

export function startWorker(channel: Channel): Worker {
  const cancel = new AbortController()
  let grant: ((id: string) => void) | undefined
  let working: Promise<void> = Promise.resolve()
  const stop = () =>
    cancel.abort(Object.assign(new Error('The run was cancelled'), { name: 'AbortError' }))
  channel.onMessage((message) => {
    if (message.t === 'init') working = init(message.run, message.file, message.select)
    else if (message.t === 'grant') grant?.(message.id)
    else stop()
  })
  // The main process closed the channel after `done`, or is gone (the CLI was killed): cancel, let
  // every attempt clean up, then go.
  channel.onDisconnect(() => {
    stop()
    void working.finally(() => channel.exit(0))
  })

  const reporter: Reporter = {
    start: (index, at) => channel.send({ t: 'start', index, at }),
    progress: (index, progress) => channel.send({ t: 'progress', index, progress }),
    debug: (index, line) => channel.send({ t: 'debug', index, line }),
    log: (index, at, stream, text) =>
      channel.send({ t: 'log', ...(index === undefined ? {} : { index }), at, stream, text }),
    result: (index, result) => channel.send({ t: 'result', index, result }),
    meta: (index, meta) => channel.send({ t: 'meta', index, meta }),
  }

  async function init(run: RunContext, file: string, select: number[] | null): Promise<void> {
    useEngine({ registerTest, registerGroup, getRunContext: () => run, collectingFile })
    extendExpect(evalMatchers)
    routeConsole(reporter)
    try {
      const tests = await collect(file, () => loadEvalModule(file, run.config.root))
      channel.send({
        t: 'collected',
        tests: tests.map(({ index, name, groups, mode, options }) => ({
          index,
          name,
          groups,
          mode,
          ...(options.attempt ? { attempt: options.attempt } : {}),
        })),
      })
      if (select) {
        grant = useSchedulerChannel((message) => channel.send(message as FromWorker))
        await runTests(tests, new Set(select), {
          file,
          stagingDir: run.stagingDir,
          signal: cancel.signal,
          reporter,
          onReady: () => channel.send({ t: 'ready' }),
        })
      }
    } catch (error) {
      channel.send({ t: 'load-error', error: serializeError(error) })
    }
    // The last message: the main process closes the channel once it has it, and the worker exits.
    channel.send({ t: 'done' })
  }

  channel.send({ t: 'hello', protocol: PROTOCOL })
  return { unhandled: (error) => channel.send({ t: 'unhandled', error: serializeError(error) }) }
}
