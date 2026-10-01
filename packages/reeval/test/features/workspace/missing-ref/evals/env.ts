import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** A ref the repository doesn't have: its attempts fail before they start. */
export const missing = defineEnvironment('missing', ({ git }) => ({
  sandbox,
  workspace: git('../repo', { ref: 'v9' }),
}))

export const pinned = defineEnvironment('pinned', ({ git }) => ({
  sandbox,
  workspace: git('../repo', { ref: 'v1' }),
}))
