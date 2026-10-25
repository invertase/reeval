import { defineEnvironment, type Turn } from 'reeval'
import { docker } from 'reeval/sandbox'

/** A server the checks call later, started by setup with the environment it gives. */
const setup = ['nohup sleep 600 >/dev/null 2>&1 &']

export const unbrokered = defineEnvironment('unbrokered', ({ secret }) => ({
  sandbox: docker(),
  env: { CHECK_TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { to: 'checks' }) },
  setup,
}))

export const brokered = defineEnvironment('brokered', ({ secret }) => ({
  sandbox: docker(),
  env: {
    CHECK_TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', {
      to: 'checks',
      hosts: ['api.example.com'],
    }),
  },
  setup,
}))

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.trim()
