import { debugLog, debugTrace } from '../debug/attempt.ts'
import { diffSinceSnapshot } from '../diff.ts'
import type { HarnessResult, HarnessSession } from '../harness/types.ts'
import { redactSecrets } from '../redact.ts'
import { InfraError, type Sandbox } from '../sandbox/index.ts'
import { clip, formatDuration, plural } from '../text.ts'
import type { Diff, ExecResult, ExecRetry, Turn, TurnData, TurnRecord } from '../types.ts'
import {
  type McpStartupLog,
  mcpStartupOf,
  mcpTimeoutMessage,
  timedOutServer,
} from './mcp-startup.ts'
import type { Attempt } from './state.ts'

/** How long a turn gets to stop once its attempt is aborted, before reeval stops waiting for it. */
const TURN_STOP_GRACE_MS = 3_000

/**
 * Resolves `grace` ms after `signal` aborts, with the turn as cut off; `cancel` drops the timer
 * once the turn settles on its own.
 */
function cutOff(signal: AbortSignal, startedAt: string, grace = TURN_STOP_GRACE_MS) {
  let timer: NodeJS.Timeout | undefined
  let onAbort = () => {}
  const cutoff = new Promise<Awaited<ReturnType<HarnessSession['send']>>>((resolve) => {
    onAbort = () => {
      timer = setTimeout(() => {
        const message = `The agent didn't stop within ${grace / 1000}s of being cancelled, so reeval stopped waiting for its turn`
        const at = Date.now() - Date.parse(startedAt)
        resolve({
          text: '',
          status: 'aborted',
          transcript: [{ type: 'error', message, ts: new Date().toISOString(), atMs: at }],
          usage: null,
          model: null,
          unreported: [],
          startedAt,
          durationMs: at,
        })
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
  exec: (command: string, options?: ExecRetry) => Promise<ExecResult>
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
    const { cutoff, cancel } = cutOff(signal, entry.startedAt)
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
        startedAt: entry.startedAt,
        durationMs: Date.now() - sendStarted,
      }
    })
    const { raw, ...sent } = await a
      .timed('agentMs', () => Promise.race([sending, cutoff]))
      .catch(async (error: unknown) => {
        // The errored entry stays in the record, with the starts the turn saw.
        if (watch) entry.mcpStartup = mcpStartupOf((await watch.end()).entries)
        throw error
      })
      .finally(() => {
        cancel()
        watch?.close()
      })
    const sendWallMs = Date.now() - sendStarted
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
    Object.assign(entry, result, raw ? { raw } : {}, {
      durationMs: Math.max(result.durationMs, sendWallMs),
      ...(startup ? { mcpStartup: mcpStartupOf(startup.entries) } : {}),
    })
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
    a.report({
      kind: 'turn-end',
      turn: turnNumber,
      status: result.status,
      ms: result.durationMs,
      tools: count('tool', 'web-search', 'web-fetch'),
      fileEdits: count('file-edit'),
      ...(failure?.type === 'error'
        ? { error: clip(redactSecrets(failure.message.trim()), 300) }
        : {}),
    })
    debugLog(
      'harness',
      `turn ${turnNumber} ${result.status} in ${formatDuration(result.durationMs)} · ${plural(count('tool', 'web-search', 'web-fetch'), 'tool call')} · ${plural(count('file-edit'), 'file edit')}${failure && 'message' in failure ? ` · error: ${clip(redactSecrets(String(failure.message)), 200)}` : ''}${result.model ? ` · model ${result.model}` : ''}`,
    )
    for (const s of entry.mcpStartup ?? []) {
      debugLog(
        'harness',
        `turn ${turnNumber} mcp ${s.server} ${s.ms === null ? "didn't answer initialize" : `answered initialize in ${formatDuration(s.ms)}`}`,
      )
    }
    if (timedOut) {
      // Fails the attempt even when the eval's body catches it, like a failed start.
      const error = new InfraError(timedOut)
      a.startFailure ??= { error }
      throw error
    }
    a.signal.throwIfAborted()
    const diff: Diff = await a.timed('diffMs', () => diffSinceSnapshot(box, a.signal))
    a.record.diff = diff
    const data: TurnData = { prompt, ...result, diff }
    const turn: Turn = Object.freeze({ ...data, ...checks })
    a.turns.push(turn)
    return turn
  }
}
