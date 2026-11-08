import { defineEnvironment, type Turn } from 'reeval'
import { hosted } from 'reeval/sandbox/hosted'

export const vm = defineEnvironment('vm', { sandbox: hosted(), egress: 'allow-all' })

/** What the scripted agent's shell command printed, one entry per line. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.split('\n') ?? []
