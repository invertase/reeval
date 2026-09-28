import { defineEnvironment, type Turn } from 'reeval'

export const listed = defineEnvironment('listed', { egress: { allow: ['api.example.com'] } })

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
