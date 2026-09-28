import { defineEnvironment } from 'evalsuite'

// features.test.ts serves the fixture's repo over HTTP, answering 401 without the token.
const url = `${process.env.ES_GIT_HTTP}/repo`

/** A repository that needs a token, read from the host's ES_FIXTURE_GIT_TOKEN. */
export const privateRepo = defineEnvironment('private', ({ git }) => ({
  workspace: git(url, { ref: 'v1', token: 'ES_FIXTURE_GIT_TOKEN' }),
}))
