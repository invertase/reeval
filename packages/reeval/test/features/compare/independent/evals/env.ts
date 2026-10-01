import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const baseline = defineEnvironment('baseline', {
  sandbox,
  files: { 'from-baseline.txt': 'baseline-only' },
})

export const variant = defineEnvironment('variant', {
  sandbox,
  files: { 'from-variant.txt': 'variant-only' },
})

/** Set on the parent group. Compare must not apply it. */
export const ignored = defineEnvironment('ignored', {
  sandbox,
  files: { 'from-ignored.txt': 'no' },
})
