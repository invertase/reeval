import { defineEnvironment } from 'evalsuite'

/** A setup step that reads the repository the workspace starts as. */
export const built = defineEnvironment('built', ({ git }) => ({
  workspace: git('../repo', { ref: 'v1' }),
  setup: ['cp VERSION seen-by-setup.txt'],
}))
