import { defineEnvironment } from 'evalsuite'

/** A ref the repository doesn't have: its attempts fail before they start. */
export const missing = defineEnvironment('missing', ({ git }) => ({
  workspace: git('../repo', { ref: 'v9' }),
}))

export const pinned = defineEnvironment('pinned', ({ git }) => ({
  workspace: git('../repo', { ref: 'v1' }),
}))
