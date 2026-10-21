import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const review = defineEnvironment('review', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.local('../plugin', { only: ['skills'] })],
}))

/** The fake agent takes plugin items flat, so the plugin's skill joins its home skills. */
export const skill = '~/.agents/skills/review-lint/SKILL.md'
export const placed = '~/.reeval/plugins/review'
