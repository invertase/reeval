import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const seeded = defineEnvironment('seeded', {
  sandbox,
  files: { 'test/greet.test.js': "import './greet.js'\n" },
})
