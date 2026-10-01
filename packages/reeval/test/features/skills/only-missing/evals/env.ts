import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const typo = defineEnvironment('typo', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills', { only: ['house-greting'], placement: 'workspace' })],
}))

export const picked = defineEnvironment('picked', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills', { only: ['house-greeting'], placement: 'workspace' })],
}))
