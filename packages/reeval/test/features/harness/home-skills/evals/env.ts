import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const greeting = defineEnvironment('greeting', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/house-greeting')],
}))

/** What the scripted agent's `n`th shell command printed. */
export const shellOutput = (turn: Turn, n: number) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[n]
