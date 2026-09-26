import { diffSinceSnapshot } from '../diff.ts'
import type { HarnessSession } from '../harness/types.ts'
import type { Sandbox } from '../sandbox/index.ts'
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
      startedAt: new Date().toISOString(),
      durationMs: 0,
    }
    a.record.turns.push(entry)
    const turnNumber = a.record.turns.length
    a.report({ kind: 'turn-start', turn: turnNumber })
    const { raw, ...result } = await a.timed('agentMs', () => agent.send(prompt, a.signal))
    Object.assign(entry, result, raw ? { raw } : {})
    await takeContext(box, a.signal)
    const count = (...types: string[]) =>
      result.transcript.filter((e) => types.includes(e.type)).length
    a.report({
      kind: 'turn-end',
      turn: turnNumber,
      status: result.status,
      ms: result.durationMs,
      tools: count('tool', 'web-search', 'web-fetch'),
      fileEdits: count('file-edit'),
    })
    a.signal.throwIfAborted()
    const diff: Diff = await a.timed('diffMs', () => diffSinceSnapshot(box, a.signal))
    a.record.diff = diff
    const turn: Turn = Object.freeze({ prompt, ...result, diff, ...checks })
    a.turns.push(turn)
    return turn
  }
}
