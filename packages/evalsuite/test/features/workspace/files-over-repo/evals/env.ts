import { defineEnvironment } from 'evalsuite'

/** The repository at v1, with `files` writing over one of its files. */
export const patched = defineEnvironment('patched', ({ git }) => ({
  workspace: git('../repo', { ref: 'v1' }),
  files: { 'greet.js': "export const greeting = 'Howdy'\n" },
}))
