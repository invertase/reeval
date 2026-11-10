// `reeval attach`: follows a run's event stream, from its file or over its server's WebSocket, and
// draws it with the renderer `reeval run` would, from the stream's first line, so attaching mid-run
// replays what already happened and then follows. It exits with the run's own exit code. On a
// terminal that's the interactive list, whose q and Ctrl-C detach this viewer and leave the run
// alone; x pressed twice cancels the run, which only a run on this host whose live.json vouches for
// its pid can be reached for. Anywhere else a SIGINT detaches the same way, and a second one quits
// as Node does. A run that writes heartbeats (its header says so) and then goes quiet
// is shown as stalled, and after longer as lost, which ends attach.
import { hostname } from 'node:os'
import { isAbsolute, join, posix, win32 } from 'node:path'
import {
  displayUrl,
  EventStreamError,
  type FollowOptions,
  followEvents,
  LOST_MS,
  STALL_MS,
} from './events.ts'
import { fromCwd } from './ids.ts'
import { CANCEL_SIGNAL, cancelable, processAlive } from './resume.ts'
import { formatDuration } from './text.ts'
import type { OutputStream, PrepareTargetView, ReevalEvent, Renderer } from './ui/events.ts'
import { createRenderer, type OutputOptions } from './ui/index.ts'
import type { RunEventLine, RunEventsHeader } from './view/events.ts'

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
  /** `STALL_MS` and `LOST_MS` unless given. */
  silence?: { stallMs?: number; lostMs?: number }
  /** Told when the viewer detaches, before `attach` returns 0. */
  onDetach?: () => void
  /** How to cancel a run this viewer can't reach, which the interactive list shows. */
  cancelHint?: string
}

const SILENT = Symbol('silent')

/**
 * A path the run printed, as this viewer reads it. The run prints paths from its own current
 * directory, which mean nothing where the viewer is, so with the header's `cwd` each becomes the
 * project's: from this viewer's directory when attach knows its project root, else from the root.
 * A stream without `cwd` keeps its paths, and so does an absolute path.
 */
export function viewerPath(header: RunEventsHeader, root: string | undefined) {
  const { cwd } = header
  return (path: string): string => {
    if (cwd === undefined || isAbsolute(path) || win32.isAbsolute(path)) return path
    const inProject = posix.join(cwd, path)
    return root === undefined ? inProject : fromCwd(join(root, inProject)) || '.'
  }
}

/** The event with the paths the renderers print made the viewer's, by `shown`. */
export function viewerEvent(
  event: ReevalEvent,
  shown: (path: string) => string,
  /** The run's config as its plan named it, which a prepare event's `setBy` repeats. */
  config: string | undefined,
): ReevalEvent {
  if (event.type === 'run-end') {
    const { recorded } = event
    return {
      ...event,
      summaryPath: shown(event.summaryPath),
      ...(recorded
        ? {
            recorded: {
              record: shown(recorded.record),
              files: recorded.files === null ? null : shown(recorded.files),
              ...(recorded.archive === undefined ? {} : { archive: shown(recorded.archive) }),
            },
          }
        : {}),
    }
  }
  if (event.type === 'plan') {
    const { config: named, record, ...rest } = event.header
    const viewed = named === undefined ? undefined : shown(named)
    // As `reeval run` does, the plan names the config only when it isn't in the current directory.
    const elsewhere = viewed !== undefined && posix.dirname(viewed) !== '.' ? viewed : undefined
    return {
      ...event,
      line:
        named === undefined
          ? event.line
          : event.line
              .split(' · ')
              .flatMap((part) =>
                part !== `config ${named}` ? [part] : elsewhere ? [`config ${elsewhere}`] : [],
              )
              .join(' · '),
      header: {
        ...rest,
        ...(elsewhere === undefined ? {} : { config: elsewhere }),
        ...(record === undefined ? {} : { record: shown(record) }),
      },
    }
  }
  if (event.type === 'prepare' && config !== undefined) {
    const target = (t: PrepareTargetView): PrepareTargetView => ({
      ...t,
      setBy: t.setBy.map((by) => (by === config ? shown(by) : by)),
    })
    if (event.state === 'start') return { ...event, targets: event.targets.map(target) }
    if (event.state === 'image') return { ...event, target: target(event.target) }
    return {
      ...event,
      outcome: { ...event.outcome, target: target(event.outcome.target) },
    }
  }
  return event
}

/**
 * Draws the stream until the run's last exit line, and returns its exit code; 0 when the viewer
 * detached first.
 */
export async function attach(options: AttachOptions): Promise<number> {
  const detached = new AbortController()
  const lost = new AbortController()
  const given = options.follow?.signal
  const signal = AbortSignal.any([detached.signal, lost.signal, ...(given ? [given] : [])])
  const alive = options.follow?.alive ?? processAlive
  const signalRun = options.signalRun ?? ((pid) => process.kill(pid, CANCEL_SIGNAL))
  const stallMs = options.silence?.stallMs ?? STALL_MS
  const lostMs = options.silence?.lostMs ?? LOST_MS
  const { root } = options
  const reachable = (line: RunEventsHeader) =>
    root !== undefined && cancelable(root, line, { alive })
  let renderer: Renderer | undefined
  /** The last segment's renderer once its exit line came, while its list may still be up. */
  let ended: Renderer | undefined
  let header: RunEventsHeader | undefined
  let shown: (path: string) => string = (path) => path
  /** The config as this segment's plan named it, before `shown`. */
  let config: string | undefined
  let code: number | undefined
  /** This segment's run writes heartbeats, so its silence means something from its header on. */
  let beating = false
  let heard = Date.now()
  let stalled = false
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
        ...(options.cancelHint === undefined ? {} : { cancelHint: options.cancelHint }),
      },
      cancel: () => {
        if (!reachable(line)) return false
        signalRun(line.pid)
        return true
      },
    })
  const notice = (level: 'info' | 'warn', text: string) =>
    renderer?.onEvent({ type: 'notice', at: Date.now(), level, text })
  const lines = followEvents(options.source, {
    onDrop: () =>
      notice(
        'warn',
        `Lost the connection to ${header ? `run ${header.runId}` : 'the run'}; reconnecting.`,
      ),
    ...options.follow,
    signal,
  })[Symbol.asyncIterator]()
  /** The next line, or `SILENT` once the run has been quiet past the next threshold. */
  const next = async (pending: Promise<IteratorResult<RunEventLine>>) => {
    if (!beating || code !== undefined) return pending
    const quietFor = Date.now() - heard
    const wait = Math.max(0, (stalled ? lostMs : stallMs) - quietFor)
    let timer: NodeJS.Timeout | undefined
    const silent = new Promise<typeof SILENT>((resolve) => {
      timer = setTimeout(() => resolve(SILENT), wait)
    })
    try {
      return await Promise.race([pending, silent])
    } finally {
      clearTimeout(timer)
    }
  }
  let pending = lines.next()
  const interrupted = () => detached.abort()
  process.once('SIGINT', interrupted)
  try {
    for (;;) {
      const got = await next(pending)
      if (got === SILENT) {
        const runId = header?.runId ?? ''
        if (stalled) {
          lost.abort()
          throw new EventStreamError(
            `no word from run ${runId} for ${formatDuration(lostMs)} and no exit line: reeval attach stopped following it as lost`,
          )
        }
        stalled = true
        notice(
          'warn',
          `No word from run ${runId} for ${formatDuration(stallMs)}: it may have stalled, or lost its connection.`,
        )
        continue
      }
      if (got.done) break
      pending = lines.next()
      const line = got.value
      heard = Date.now()
      if (stalled && line.type !== 'header') {
        stalled = false
        notice('info', `Run ${header?.runId ?? ''} is sending again.`)
      }
      if (detached.signal.aborted) break
      if (line.type === 'heartbeat') {
        beating = true
        continue
      }
      if (line.type === 'header') {
        // A resume of the run starts its own output, as its terminal did.
        renderer?.close()
        const last = renderer ?? ended
        renderer = ended = undefined
        await last?.dismiss?.()
        code = undefined
        beating = line.heartbeatMs !== undefined
        stalled = false
        header = line
        shown = viewerPath(line, root)
        config = undefined
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
      if (line.type === 'plan') config = line.header.config
      renderer?.onEvent(viewerEvent(line, shown, config))
    }
  } catch (error) {
    if (!detached.signal.aborted) {
      renderer?.close()
      await (renderer ?? ended)?.dismiss?.()
      throw error
    }
  } finally {
    process.off('SIGINT', interrupted)
    pending.catch(() => {})
    lines.return?.(undefined).catch(() => {})
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
    options.onDetach?.()
    return 0
  }
  if (code === undefined) {
    throw new EventStreamError(
      `the event stream at ${displayUrl(options.source)} ended before the run did`,
    )
  }
  return code
}
