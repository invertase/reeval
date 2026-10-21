import { defineEnvironment, type Turn } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

export const plain = defineEnvironment('plain', { sandbox: container() })

/** Root, for the canary: the agent is root, so it can read root's directories. */
export const rooted = defineEnvironment('rooted', { sandbox: container({ root: true }) })

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
