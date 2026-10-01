import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// features.test.ts adds fixture/node_modules/ and fixture/dist/ before the run: gitignored here.
export const fixtureDir = defineEnvironment('fixture-dir', ({ directory }) => ({
  sandbox,
  files: { ...directory('../fixture'), 'README.md': 'overridden' },
}))

export const listing = 'find . -type f | LC_ALL=C sort'
