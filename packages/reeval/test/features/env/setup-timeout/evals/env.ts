import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const slow = defineEnvironment('slow', {
  sandbox,
  setup: [{ run: 'sleep 30 && touch slept', timeout: '1s' }],
})

export const quick = defineEnvironment('quick', {
  sandbox,
  setup: [{ run: 'touch slept', timeout: '30s' }],
})
