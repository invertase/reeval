import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** Only a sandbox: no files, no skills. */
export const empty = defineEnvironment('empty', { sandbox })

export const variant = defineEnvironment('variant', {
  sandbox,
  files: { 'from-variant.txt': 'variant-only' },
})
