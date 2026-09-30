import { defineEnvironment } from 'reeval'

export const variant = defineEnvironment('variant', {
  files: { 'from-variant.txt': 'variant-only' },
})
