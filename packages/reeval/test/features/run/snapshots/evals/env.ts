import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const snapshots = defineEnvironment('snapshots', {
  sandbox,
  files: { 'app/start.js': 'export const start = 1\n' },
  setup: [
    { run: 'mkdir -p node_modules/dep && echo "module.exports = 1" > node_modules/dep/index.js' },
  ],
})
