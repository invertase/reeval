import { defineEnvironment, type Turn } from 'reeval'

export const greeting = defineEnvironment('greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

/** What real Cursor is asked; the scripted fake runs the same `cat` without reading it. */
export const prompt =
  'Run exactly `cat ~/.agents/skills/house-greeting/SKILL.md` once, and reply with its output only.'

/**
 * What the agent's `n`th shell command printed, or '' when it ran fewer: the fake's `shell` tool
 * reports stdout as its output, Cursor's `bash` tool as `output.stdout`.
 */
export const shellOutput = (turn: Turn, n: number): string =>
  turn.transcript.flatMap((e) => {
    if (e.type !== 'tool' || (e.tool !== 'shell' && e.tool !== 'bash')) return []
    const out = e.output as string | { stdout?: string } | null
    return [typeof out === 'string' ? out : (out?.stdout ?? '')]
  })[n] ?? ''
