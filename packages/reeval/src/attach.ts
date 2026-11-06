// `reeval attach`: follows a run's event stream and draws it with the renderer `reeval run` would,
// from the stream's first line, so attaching mid-run replays what already happened and then
// follows. It exits with the run's own exit code. On a terminal that's the interactive list, whose
// q and Ctrl-C detach this viewer and leave the run alone; x pressed twice cancels the run, which
// only a run on this host whose live.json vouches for its pid can be reached for.
import { hostname } from 'node:os'
import { EventStreamError, type FollowOptions, followEvents } from './events.ts'
import { CANCEL_SIGNAL, cancelable, processAlive } from './resume.ts'
import type { OutputStream, Renderer } from './ui/events.ts'
import { createRenderer, type OutputOptions } from './ui/index.ts'
import type { RunEventsHeader } from './view/events.ts'

export type AttachOptions = {
  /** A stream file or URL. */
  source: string
  out: OutputStream
  /** How to print, given the run's `-v` level (`-v` defaults `--output-logs` to full). */
  output: (verbosity: 0 | 1 | 2) => OutputOptions
  columns?: number
  colorDepth?: number
  /** The terminal the interactive list draws on and reads keys from. */
  tty?: { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream }
  /** The run's project, whose staging has its live.json; without one, the run can't be canceled. */
  root?: string
  follow?: FollowOptions
  /** Asks the run's process to cancel, as a first Ctrl-C in its own terminal does. */
  signalRun?: (pid: number) => void
}

/**
 * Draws the stream until the run's last exit line, and returns its exit code; 0 when the viewer
 * detached first.
 */
export async function attach(options: AttachOptions): Promise<number> {
  const detached = new AbortController()
  const given = options.follow?.signal
  const signal = given ? AbortSignal.any([given, detached.signal]) : detached.signal
  const alive = options.follow?.alive ?? processAlive
  const signalRun = options.signalRun ?? ((pid) => process.kill(pid, CANCEL_SIGNAL))
  const { root } = options
  const reachable = (line: RunEventsHeader) =>
    root !== undefined && cancelable(root, line, { alive })
  let renderer: Renderer | undefined
  /** The last segment's renderer once its exit line came, while its list may still be up. */
  let ended: Renderer | undefined
  let header: RunEventsHeader | undefined
  let code: number | undefined
  const rendererFor = (line: RunEventsHeader) =>
    createRenderer({
      out: options.out,
      output: options.output(line.verbosity),
      harness: line.harness,
      verbosity: line.verbosity,
      ...(options.columns === undefined ? {} : { columns: options.columns }),
      ...(options.colorDepth === undefined ? {} : { colorDepth: options.colorDepth }),
      ...(options.tty ? { tty: options.tty } : {}),
      attached: {
        detach: () => detached.abort(),
        ...(line.host === hostname() ? {} : { host: line.host }),
        ...(root === undefined ? {} : { cancelable: () => reachable(line) }),
      },
      cancel: () => {
        if (!reachable(line)) return false
        signalRun(line.pid)
        return true
      },
    })
  try {
    for await (const line of followEvents(options.source, { ...options.follow, signal })) {
      if (detached.signal.aborted) break
      if (line.type === 'header') {
        // A resume of the run starts its own output, as its terminal did.
        renderer?.close()
        const last = renderer ?? ended
        renderer = ended = undefined
        await last?.dismiss?.()
        code = undefined
        header = line
        renderer = rendererFor(line)
        continue
      }
      if (line.type === 'exit') {
        renderer?.close()
        ended = renderer
        renderer = undefined
        code = line.code
        continue
      }
      renderer?.onEvent(line)
    }
  } catch (error) {
    if (!detached.signal.aborted) {
      renderer?.close()
      await (renderer ?? ended)?.dismiss?.()
      throw error
    }
  }
  renderer?.close()
  await (renderer ?? ended)?.wait?.()
  if (detached.signal.aborted) {
    if (header) {
      const goesOn = code === undefined && header.host === hostname() && reachable(header)
      options.out.write(
        goesOn
          ? `Detached from run ${header.runId}; it goes on.\n`
          : `Detached from run ${header.runId}.\n`,
      )
    }
    return 0
  }
  if (code === undefined) {
    throw new EventStreamError(`the event stream at ${options.source} ended before the run did`)
  }
  return code
}
