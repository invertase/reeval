import { evaluate, expect } from 'reeval'
import { keptWorkspace } from './env.ts'

// Must fail: the agent built the app, not something else. It keeps no workspace.
evaluate('canary', { environment: keptWorkspace, keepWorkspace: false }, async (c) => {
  await c.send('build the app')
  expect(await c.readFile('app/built.js')).toBe('something else')
})
