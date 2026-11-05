import { TURN_EDITED } from '../assert.ts'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { changedBetween, diffSinceSnapshot, workspaceBlobs } from '../diff.ts'
import { ProviderStopError } from '../harness/provider-stop.ts'
import type { HarnessResult, HarnessSession } from '../harness/types.ts'
import { redactSecrets } from '../redact.ts'
import { InfraError, type Sandbox } from '../sandbox/index.ts'
import { clip, formatDuration, plural } from '../text.ts'
import type { ExecEnv, ExecResult, ExecRetry, Turn, TurnData, TurnRecord } from '../types.ts'
import {
  type McpStartupLog,
  mcpStartupOf,
  mcpTimeoutMessage,
  timedOutServer,
} from './mcp-startup.ts'
import { takeSnapshot } from './snapshot.ts'
import type { Attempt } from './state.ts'

/** How long a turn gets to stop once its attempt is aborted, before reeval stops waiting for it. */
const TURN_STOP_GRACE_MS = 3_000

/**
 * Resolves `grace` ms after `signal` aborts, with the turn as cut off: what the session says it
 * got to, or an empty turn; `cancel` drops the timer once the turn settles on its own.
 */
function cutOff(
  signal: AbortSignal,
  startedAt: string,
  session: HarnessSession,
  grace = TURN_STOP_GRACE_MS,
) {
  let timer: NodeJS.Timeout | undefined
  let onAbort = () => {}
  const cutoff = new Promise<HarnessResult>((resolve) => {
    onAbort = () => {
      timer = setTimeout(() => {
        const message = `The agent didn't stop within ${grace / 1000}s of being canceled, so reeval stopped waiting for its turn`
        const at = Date.now() - Date.parse(startedAt)
        const note = { type: 'error' as const, message, ts: new Date().toISOString(), atMs: at }
        const empty: HarnessResult = {
          text: '',
          status: 'aborted',
          transcript: [note],
          usage: null,
          model: null,
          unreported: [],
          reasoningMs: null,
          startedAt,
          durationMs: at,
        }
        if (!session.stopped) return resolve(empty)
        session.stopped(note).then(resolve, () => resolve(empty))
      }, grace)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  const cancel = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  return { cutoff, cancel }
}

/** How often a turn reads the MCP timer's log for a server that never answered `initialize`. */
const MCP_POLL_MS = 2_000

/**
 * Reads the MCP timer's log through a turn. `signal` aborts as soon as a server has timed out, so
 * an agent stuck waiting for it stops; `end` takes the turn's last entries.
 */
function watchMcpStartup(log: McpStartupLog) {
  const stop = new AbortController()
  const entries: Awaited<ReturnType<McpStartupLog['read']>> = []
  let timedOut: string | undefined
  let at = 0
  let reading: Promise<void> | undefined
  const poll = async () => {
    entries.push(...(await log.read()))
    timedOut ??= timedOutServer(entries)
    if (timedOut && !stop.signal.aborted) {
      at = Date.now()
      stop.abort(new InfraError(mcpTimeoutMessage(timedOut)))
    }
  }
  const timer = setInterval(() => {
    reading ??= poll().finally(() => {
      reading = undefined
    })
  }, MCP_POLL_MS)
  return {
    signal: stop.signal,
    close: () => clearInterval(timer),
    async end() {
      clearInterval(timer)
      await reading
      await poll()
      return { entries, timedOut, at: at || Date.now() }
    },
  }
}

type Checks = {
  exec: (command: string, options?: ExecRetry & { env?: ExecEnv }) => Promise<ExecResult>
  readFile: (path: string) => Promise<string | null>
}

/**
 * One turn. Sends the prompt to the started session, records the turn as it goes (an
 * errored entry first, so a turn that throws is still in the record), takes the agent's context
 * after the first, and diffs the workspace since the snapshot.
 */
export function turnSender(
  a: Attempt,
  takeContext: (box: Sandbox, signal: AbortSignal) => Promise<void>,
  checks: Checks,
) {
  return async (prompt: string): Promise<Turn> => {
    const [box, agent] = await a.start('c.send()')
    const before = await a.timed('diffMs', () => workspaceBlobs(box, a.signal))
    const entry: TurnRecord = {
      prompt,
      text: '',
      status: 'error',
      transcript: [],
      usage: null,
      model: null,
      unreported: [],
      startedAt: new Date().toISOString(),
      durationMs: 0,
    }
    a.record.turns.push(entry)
    const turnNumber = a.record.turns.length
    a.report({ kind: 'turn-start', turn: turnNumber })
    debugLog(
      'harness',
      `turn ${turnNumber} started: ${JSON.stringify(clip(redactSecrets(prompt), 160))}`,
    )
    debugTrace('harness', 'prompt', { turn: turnNumber, prompt }, `turn ${turnNumber} prompt`)
    const watch = a.mcpStartup && watchMcpStartup(a.mcpStartup)
    const signal = watch ? AbortSignal.any([a.signal, watch.signal]) : a.signal
    // An agent that ignores the abort would hold the attempt, and the run, until it finishes.
    const { cutoff, cancel } = cutOff(signal, entry.startedAt, agent)
    const sendStarted = Date.now()
    const sending = agent.send(prompt, signal).catch((error: unknown): HarnessResult => {
      // A harness whose turn throws on abort (the fake agent's commands do) was cut off by the
      // MCP timeout, which then fails the turn below.
      if (!watch?.signal.aborted || a.signal.aborted) throw error
      return {
        text: '',
        status: 'aborted',
        transcript: [],
        usage: null,
        model: null,
        unreported: [],
        reasoningMs: null,
        startedAt: entry.startedAt,
        durationMs: Date.now() - sendStarted,
      }
    })
    const timedBefore = a.record.timings.agentMs
    const { raw, rejectedKey, providerStop, reasoningMs, agentMs, steps, cost, ...sent } = await a
      .timed('agentMs', () => Promise.race([sending, cutoff]))
      .catch(async (error: unknown) => {
        // The errored entry stays in the record, with the starts the turn saw.
        entry.reasoningMs = null
        if (watch) entry.mcpStartup = mcpStartupOf((await watch.end()).entries)
        throw error
      })
      .finally(() => {
        cancel()
        watch?.close()
      })
    if (steps) a.turnSteps.set(entry, steps)
    const sendWallMs = agentMs ?? Date.now() - sendStarted
    if (agentMs !== undefined) a.record.timings.agentMs = timedBefore + agentMs
    const startup = await watch?.end()
    const timedOut = startup?.timedOut && mcpTimeoutMessage(startup.timedOut)
    const seenAt = startup?.at ?? Date.now()
    // The timeout goes in at the moment it was seen, before any error the abort caused.
    const result = timedOut
      ? {
          ...sent,
          status: 'error' as const,
          transcript: [
            ...sent.transcript,
            {
              type: 'error' as const,
              message: timedOut,
              ts: new Date(seenAt).toISOString(),
              atMs: Math.max(0, seenAt - Date.parse(sent.startedAt)),
            },
          ].sort((x, y) => x.atMs - y.atMs),
        }
      : sent
    Object.assign(
      entry,
      result,
      raw ? { raw } : {},
      reasoningMs !== undefined ? { reasoningMs } : {},
      cost ? { cost } : {},
      {
        durationMs: Math.max(result.durationMs, sendWallMs),
        ...(startup ? { mcpStartup: mcpStartupOf(startup.entries) } : {}),
      },
    )
    for (const event of result.transcript) {
      debugTrace(
        'harness',
        'transcript',
        { turn: turnNumber, ...event },
        `transcript ${event.type}`,
      )
    }
    await takeContext(box, a.signal)
    const count = (...types: string[]) =>
      result.transcript.filter((e) => types.includes(e.type)).length
    const failure = result.transcript.find((e) => e.type === 'error')
    // The agent never got to work, or its provider stopped it, so checks on its workspace say
    // nothing about it.
    const stopped = result.status === 'aborted' ? undefined : providerStop
    const infra = timedOut || (result.status !== 'aborted' && rejectedKey) || stopped?.message
    // The diff counts every write, the shell's too. The turn's own files are the ones that moved
    // since it started, so the eval's c.exec and c.writeFile between turns aren't in them.
    let changes: Awaited<ReturnType<typeof diffSinceSnapshot>> | undefined
    let diffError: unknown
    if (!infra && !a.signal.aborted) {
      try {
        changes = await a.timed('diffMs', () => diffSinceSnapshot(box, a.signal))
      } catch (error) {
        diffError = error
      }
    }
    const edited = changes ? changedBetween(before, changes.blobs) : undefined
    const filesChanged = edited?.length
    a.report({
      kind: 'turn-end',
      turn: turnNumber,
      status: result.status,
      ms: result.durationMs,
      tools: count('tool', 'web-search', 'web-fetch'),
      fileEdits: count('file-edit'),
      ...(filesChanged === undefined ? {} : { filesChanged }),
      ...(failure?.type === 'error'
        ? { error: clip(redactSecrets(failure.message.trim()), 300) }
        : {}),
    })
    debugLog(
      'harness',
      `turn ${turnNumber} ${result.status} in ${formatDuration(result.durationMs)} · ${plural(count('tool', 'web-search', 'web-fetch'), 'tool call')} · ${filesChanged === undefined ? '' : `${plural(filesChanged, 'file')} changed · `}${plural(count('file-edit'), 'edit tool call')}${failure && 'message' in failure ? ` · error: ${clip(redactSecrets(String(failure.message)), 200)}` : ''}${result.model ? ` · model ${result.model}` : ''}`,
    )
    for (const s of entry.mcpStartup ?? []) {
      debugLog(
        'harness',
        `turn ${turnNumber} mcp ${s.server} ${s.ms === null ? "didn't answer initialize" : `answered initialize in ${formatDuration(s.ms)}`}`,
      )
    }
    if (infra) {
      // Fails the attempt even when the eval's body catches it, like a failed start.
      const error = !timedOut && stopped ? new ProviderStopError(stopped) : new InfraError(infra)
      a.startFailure ??= { error }
      throw error
    }
    a.signal.throwIfAborted()
    if (diffError !== undefined || !changes || !edited) throw diffError
    const { diff } = changes
    a.record.diff = diff
    if (a.spec.snapshot.when === 'turns')
      await takeSnapshot(a, box, `turn-${turnNumber}`, 'harness')
    const data: TurnData = { prompt, ...result, diff }
    const turn: Turn = Object.freeze(
      Object.assign({ ...data, ...checks }, { [TURN_EDITED]: edited }),
    )
    a.turns.push(turn)
    return turn
  }
}
