import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// features.test.ts serves the fixture's repo over HTTP, answering 401 without the token.
const url = `${process.env.REEVAL_GIT_HTTP}/repo`

/** A repository that needs a token, read from the host's REEVAL_FIXTURE_GIT_TOKEN. */
export const privateRepo = defineEnvironment('private', ({ git }) => ({
  sandbox,
  workspace: git(url, { ref: 'v1', token: 'REEVAL_FIXTURE_GIT_TOKEN' }),
}))
