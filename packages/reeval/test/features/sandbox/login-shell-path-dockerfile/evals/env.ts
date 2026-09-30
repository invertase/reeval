import { defineEnvironment, type Turn } from 'reeval'

export const plain = defineEnvironment('plain', {})

export const TOOL = '/opt/reeval-fixture/bin/reeval-fixture-tool'

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
