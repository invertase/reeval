import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const parent = defineEnvironment('parent', {
  sandbox: docker({ from: 'node:22-bookworm' }),
})
const child = parent.extend('child', {
  sandbox: docker({ from: 'node:24-bookworm' }),
})

evaluate('parent image', { environment: parent }, async () => {})
evaluate('child replaces sandbox', { environment: child }, async () => {})
