import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

const tier = process.env.REEVAL_FIXTURE_SANDBOX
const sandbox =
  tier === 'podman'
    ? podman()
    : tier === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// Exits before it listens, as a dev server missing its dependencies does.
const server = `console.error('Error: Cannot find module vite')
process.exit(1)
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
