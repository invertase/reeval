import { defineEnvironment } from 'reeval'

// features.test.ts adds fixture/node_modules/ and fixture/dist/ before the run: gitignored here.
export const fixtureDir = defineEnvironment('fixture-dir', ({ directory }) => ({
  files: { ...directory('../fixture'), 'README.md': 'overridden' },
}))

export const listing = 'find . -type f | LC_ALL=C sort'
