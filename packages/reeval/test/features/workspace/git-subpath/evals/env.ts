import { defineEnvironment } from 'evalsuite'

/** The monorepo's `app/` directory at the v1 tag, as the whole workspace. */
export const app = defineEnvironment('app-v1', ({ git }) => ({
  workspace: git('../repo', { ref: 'v1', path: 'app' }),
}))
