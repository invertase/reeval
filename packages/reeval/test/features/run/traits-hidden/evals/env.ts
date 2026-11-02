import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const base = defineEnvironment('base', {
  sandbox,
  files: { 'app.txt': 'app' },
  traits: { stack: 'next', marker: 'trait-zx81' },
})
export const hidden = base.extend('hidden', { traits: { auth: ['clerk', 'none'] } })
// The canary's environment writes the trait's value where the agent can read it.
export const leaked = hidden.extend('leaked', { files: { 'leak.txt': 'trait-zx81' } })
