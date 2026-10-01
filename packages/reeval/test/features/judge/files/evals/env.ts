import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** A README the agent never touches. */
export const app = defineEnvironment('readme-app', {
  sandbox,
  files: { 'README.md': 'Run npm start\n' },
})
