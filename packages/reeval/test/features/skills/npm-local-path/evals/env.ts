import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// Relative to this file, like skill.local and file(), not to reeval's working directories.
export const vendored = defineEnvironment('npm-vendored', ({ skill }) => ({
  sandbox,
  skills: [skill.npm('../vendor/acme-skills-1.2.3.tgz', { placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
