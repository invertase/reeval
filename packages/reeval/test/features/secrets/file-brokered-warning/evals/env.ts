import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const keys = defineEnvironment('keys', ({ secret }) => ({
  sandbox,
  egress: { allow: [process.env.REEVAL_EGRESS_HOST ?? 'missing.invalid'] },
  env: { API_KEY: secret.fromEnv('API_KEY'), OTHER_KEY: secret.fromEnv('OTHER_KEY') },
}))

/** What the scripted agent's shell command printed, one entry per line. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.split('\n') ?? []
