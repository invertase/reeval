import { defineEnvironment, type Turn } from 'reeval'

export const listed = defineEnvironment('listed', {
  egress: { allow: [process.env.REEVAL_EGRESS_HOST ?? 'missing.invalid'] },
})
export const closed = defineEnvironment('closed', { egress: 'deny-all' })

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
