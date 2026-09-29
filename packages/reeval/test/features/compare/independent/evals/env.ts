import { defineEnvironment } from 'reeval'

export const baseline = defineEnvironment('baseline', {
  files: { 'from-baseline.txt': 'baseline-only' },
})

export const variant = defineEnvironment('variant', {
  files: { 'from-variant.txt': 'variant-only' },
})

/** Set on the eval as `environment`. Compare must not apply it. */
export const ignored = defineEnvironment('ignored', {
  files: { 'from-ignored.txt': 'no' },
})
