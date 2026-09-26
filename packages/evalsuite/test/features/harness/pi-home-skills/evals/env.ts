import { defineEnvironment, type Turn } from 'evalsuite'

export const greeting = defineEnvironment('greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

/** What the scripted agent's `n`th shell command printed. */
export const shellOutput = (turn: Turn, n: number) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[n]
