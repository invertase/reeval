import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const pinned = defineEnvironment('registry-v1', ({ skill }) => ({
  sandbox,
  skills: [skill.registry('acme/skills@house-greeting', { version: 'v1', placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
