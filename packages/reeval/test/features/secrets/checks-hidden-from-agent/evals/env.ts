import { defineEnvironment, type Turn } from 'reeval'

export const tokens = defineEnvironment('tokens', ({ secret }) => ({
  env: { CHECK_TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { to: 'checks' }) },
}))

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
