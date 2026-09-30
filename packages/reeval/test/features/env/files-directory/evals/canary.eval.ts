import { evaluate, expect } from 'reeval'
import { fixtureDir, listing } from './env.ts'

// Must fail: node_modules/ and dist/ are default ignores, so they never land.
evaluate('canary', { environment: fixtureDir }, async (c) => {
  await c.sandbox()
  expect((await c.exec(listing)).stdout).toBe(
    './README.md\n./dist/app.js\n./lib/build/tool.js\n./node_modules/dep/index.js\n./package.json\n./src/index.js\n',
  )
})
