import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const host = process.env.REEVAL_EGRESS_HOST ?? 'missing.invalid'

export const keyed = defineEnvironment('keyed', ({ secret }) => ({
  sandbox,
  egress: 'deny-all',
  env: { TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { hosts: [host] }) },
}))
export const closed = defineEnvironment('closed', { sandbox, egress: 'deny-all' })

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
