import { defineEnvironment } from 'evalsuite'

/** The repository at v1, with init: true giving the workspace a .git of its own. */
export const repo = defineEnvironment('with-git', ({ git }) => ({
  workspace: git('../repo', { ref: 'v1', init: true }),
}))
