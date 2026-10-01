import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** Set on the parent group. Without a baseline, compare runs it as the control. */
export const inherited = defineEnvironment('inherited', {
  sandbox,
  files: { 'from-inherited.txt': 'inherited' },
})

export const variant = defineEnvironment('variant', {
  sandbox,
  files: { 'from-variant.txt': 'variant-only' },
})
