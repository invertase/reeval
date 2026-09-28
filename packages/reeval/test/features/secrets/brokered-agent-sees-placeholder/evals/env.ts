import { defineEnvironment, type Turn } from 'reeval'

export const keys = defineEnvironment('keys', ({ secret }) => ({
  env: { API_KEY: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { hosts: ['api.example.com'] }) },
}))

/** What the scripted agent's shell command printed, one entry per line. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.split('\n') ?? []
