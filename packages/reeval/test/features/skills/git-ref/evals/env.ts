import { fileURLToPath } from 'node:url'
import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const repo = `file://${fileURLToPath(new URL('../repo', import.meta.url))}`

export const pinned = defineEnvironment('greeting-v1', ({ skill }) => ({
  sandbox,
  skills: [skill.git(repo, { ref: 'v1', path: 'skills', placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
