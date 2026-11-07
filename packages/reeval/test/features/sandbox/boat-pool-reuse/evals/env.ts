import { defineEnvironment, type Turn } from 'reeval'
import { boat } from 'reeval/sandbox/boat'

export const vm = defineEnvironment('vm', {
  sandbox: boat({ reuse: true, maxConcurrent: 1 }),
  egress: 'allow-all',
})

/** What the scripted agent's shell command printed, one entry per line. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.split('\n') ?? []
