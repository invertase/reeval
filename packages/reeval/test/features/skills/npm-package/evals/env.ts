import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const pinned = defineEnvironment('npm-1.2.3', ({ skill }) => ({
  sandbox,
  skills: [skill.npm('@acme/skills@1.2.3', { placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
