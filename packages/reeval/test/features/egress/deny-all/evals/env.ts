import { defineEnvironment, type Turn } from 'reeval'

export const closed = defineEnvironment('closed', { egress: 'deny-all' })
export const open = defineEnvironment('open', { egress: 'allow-all' })

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
