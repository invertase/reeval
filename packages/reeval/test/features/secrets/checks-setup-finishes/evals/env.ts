import { defineEnvironment, type Turn } from 'reeval'
import { docker } from 'reeval/sandbox'

export const finishes = defineEnvironment('finishes', ({ secret }) => ({
  sandbox: docker(),
  env: { CHECK_TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { to: 'checks' }) },
  setup: ['echo ready > ready.txt'],
}))

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.trim()
