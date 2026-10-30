import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker' || process.env.REEVAL_FIXTURE_SANDBOX === 'podman'
    ? container()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const egress = { allow: [process.env.REEVAL_EGRESS_HOST ?? 'missing.invalid'] }

export const quiet = defineEnvironment('quiet', { sandbox, egress })
export const loud = defineEnvironment('loud', {
  sandbox,
  egress,
  env: { REEVAL_FIXTURE_LOUD: '1' },
})

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
