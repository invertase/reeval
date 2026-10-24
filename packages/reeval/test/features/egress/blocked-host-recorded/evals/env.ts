import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker' || process.env.REEVAL_FIXTURE_SANDBOX === 'podman'
    ? container()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const listed = defineEnvironment('listed', {
  sandbox,
  egress: { allow: ['api.example.com'] },
})

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
