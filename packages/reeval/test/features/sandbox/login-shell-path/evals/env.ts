import { defineEnvironment, type Turn } from 'reeval'
import { docker } from 'reeval/sandbox'

export const plain = defineEnvironment('plain', {
  sandbox: docker({ from: 'reeval-fixture-login-path:latest', id: 'docker' }),
})

/** reeval's own image, for the canary. */
export const stock = defineEnvironment('stock', { sandbox: docker({ id: 'docker' }) })

export const TOOL = '/opt/reeval-fixture/bin/reeval-fixture-tool'

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
