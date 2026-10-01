import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** The monorepo's `app/` directory at the v1 tag, as the whole workspace. */
export const app = defineEnvironment('app-v1', ({ git }) => ({
  sandbox,
  workspace: git('../repo', { ref: 'v1', path: 'app' }),
}))
