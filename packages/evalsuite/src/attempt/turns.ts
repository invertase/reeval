import { debugLog, debugTrace } from '../debug/attempt.ts'
import { diffSinceSnapshot } from '../diff.ts'
import type { HarnessSession } from '../harness/types.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox } from '../sandbox/index.ts'
import { clip, formatDuration } from '../text.ts'
import type { Diff, ExecResult, Turn } from '../types.ts'
import type { Attempt } from './state.ts'

type Checks = {
  exec: (command: string) => Promise<ExecResult>
  readFile: (path: string) => Promise<string | null>
}

/**
 * Phase 3: one turn. Sends the prompt to the started session, records the turn as it goes (an
 * errored entry first, so a turn that throws is still in the record), takes the agent's context
 * after the first, and diffs the workspace since the snapshot.
 */
export function turnSender(
  a: Attempt,
  start: () => Promise<[Sandbox, HarnessSession]>,
  takeContext: (box: Sandbox, signal: AbortSignal) => Promise<void>,
  checks: Checks,
) {
  return async (prompt: string): Promise<Turn> => {
    const [box, agent] = await start()
    const entry = {
      prompt,
      text: '',
      status: 'error' as const,
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
    debugLog('harness', `turn ${turnNumber} started: ${JSON.stringify(clip(prompt, 160))}`)
    debugTrace('harness', 'prompt', { turn: turnNumber, prompt }, `turn ${turnNumber} prompt`)
    const { raw, ...result } = await a.timed('agentMs', () => agent.send(prompt, a.signal))
    Object.assign(entry, result, raw ? { raw } : {})
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
        ? { error: redactSecrets(clip(failure.message.trim(), 300)) }
        : {}),
    })
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    debugLog(
      'harness',
      `turn ${turnNumber} ${result.status} in ${formatDuration(result.durationMs)} · ${plural(count('tool', 'web-search', 'web-fetch'), 'tool call')} · ${plural(count('file-edit'), 'file edit')}${failure && 'message' in failure ? ` · error: ${clip(String(failure.message), 200)}` : ''}`,
    )
    a.signal.throwIfAborted()
    const diff: Diff = await a.timed('diffMs', () => diffSinceSnapshot(box, a.signal))
    a.record.diff = diff
    const turn: Turn = Object.freeze({ prompt, ...result, diff, ...checks })
    a.turns.push(turn)
    return turn
  }
}
