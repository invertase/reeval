import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const greeting = defineEnvironment('greeting', ({ skill }) => ({
  sandbox,
  skills: [
    skill.local('../skills/house-greeting', {
      placement: 'workspace',
      exclude: ['/drafts/', '*.tmp'],
    }),
  ],
}))

export const listStaged = 'cd .agents/skills/house-greeting && find . -type f | LC_ALL=C sort'
