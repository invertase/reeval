import { defineEnvironment, type Turn } from 'reeval'

export const plain = defineEnvironment('plain', {})

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
