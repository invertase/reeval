import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** The repository at v1, with `files` writing over one of its files. */
export const patched = defineEnvironment('patched', ({ git }) => ({
  sandbox,
  workspace: git('../repo', { ref: 'v1' }),
  files: { 'greet.js': "export const greeting = 'Howdy'\n" },
}))
