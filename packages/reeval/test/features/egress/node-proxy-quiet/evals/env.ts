import { defineEnvironment, type Turn } from 'reeval'
import { docker } from 'reeval/sandbox'

const sandbox = docker({ dockerfile: '../docker/Dockerfile', id: 'docker' })
const egress = { allow: [process.env.REEVAL_EGRESS_HOST ?? 'missing.invalid'] }

/** The image's own Node. */
export const quiet = defineEnvironment('quiet', { sandbox, egress })
/** Node 22, which the Dockerfile puts beside it. */
export const loud = defineEnvironment('loud', {
  sandbox,
  egress,
  env: { REEVAL_FIXTURE_NODE: '/opt/node-22/node' },
})

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
