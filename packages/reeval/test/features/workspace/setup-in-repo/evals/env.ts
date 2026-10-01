import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** A setup step that reads the repository the workspace starts as. */
export const built = defineEnvironment('built', ({ git }) => ({
  sandbox,
  workspace: git('../repo', { ref: 'v1' }),
  setup: ['cp VERSION seen-by-setup.txt'],
}))
