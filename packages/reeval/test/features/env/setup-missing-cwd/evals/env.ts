import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const missing = defineEnvironment('missing', {
  sandbox,
  setup: [{ run: 'touch ran', cwd: 'nope/dir' }],
})

export const present = defineEnvironment('present', {
  sandbox,
  files: { 'sub/.keep': '' },
  setup: [{ run: 'touch ran', cwd: 'sub' }],
})
