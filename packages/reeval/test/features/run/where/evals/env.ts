import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const next = defineEnvironment('next-app', {
  sandbox,
  files: { 'stack.txt': 'next' },
  traits: { stack: 'next' },
})
export const vite = defineEnvironment('vite-app', {
  sandbox,
  files: { 'stack.txt': 'vite' },
  traits: { stack: 'vite' },
})
