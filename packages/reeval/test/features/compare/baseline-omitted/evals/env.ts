import { defineEnvironment } from 'reeval'

/** Set on the parent group. Without a baseline, compare runs it as the control. */
export const inherited = defineEnvironment('inherited', {
  files: { 'from-inherited.txt': 'inherited' },
})

export const variant = defineEnvironment('variant', {
  files: { 'from-variant.txt': 'variant-only' },
})
