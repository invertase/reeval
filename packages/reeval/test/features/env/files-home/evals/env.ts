import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const homeFiles = defineEnvironment('home-files', {
  sandbox,
  files: { '~/.config/es/hint.txt': 'from home' },
})
