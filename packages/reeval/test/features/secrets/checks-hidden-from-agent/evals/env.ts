import { defineEnvironment, type Turn } from 'evalsuite'

export const tokens = defineEnvironment('tokens', ({ secret }) => ({
  env: { CHECK_TOKEN: secret.fromEnv('ES_FIXTURE_TOKEN', { to: 'checks' }) },
}))

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
