import { fileURLToPath } from 'node:url'
import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const repo = `file://${fileURLToPath(new URL('../repo', import.meta.url))}`

// No path: the repository's root has no SKILL.md, so reeval looks in its skills/ directory.
export const greeting = defineEnvironment('skills-dir', ({ skill }) => ({
  sandbox,
  skills: [skill.git(repo, { placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
