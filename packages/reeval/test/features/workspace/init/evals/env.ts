import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** The repository at v1, with init: true giving the workspace a .git of its own. */
export const repo = defineEnvironment('with-git', ({ git }) => ({
  sandbox,
  workspace: git('../repo', { ref: 'v1', init: true }),
}))
