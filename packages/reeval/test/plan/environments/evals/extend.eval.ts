import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const parent = defineEnvironment('parent', {
  sandbox: docker({ from: 'node:22-bookworm' }),
})
const child = parent.extend('child', {
  sandbox: docker({ from: 'node:24-bookworm' }),
})
const kept = parent.extend('kept', { env: { MODE: 'x' } })

evaluate('parent image', { environments: parent }, async () => {})
evaluate('child replaces sandbox', { environments: child }, async () => {})
evaluate('child keeps parent sandbox', { environments: kept }, async () => {})
