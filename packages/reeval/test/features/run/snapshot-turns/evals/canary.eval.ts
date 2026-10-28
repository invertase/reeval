import { evaluate, expect } from 'reeval'
import { snapshots } from './env.ts'

// Must fail: the agent built the app, not something else. Its snapshots are directories.
evaluate('canary', { environment: snapshots, snapshot: 'turns' }, async (c) => {
  await c.send('build the app')
  expect(await c.readFile('app/built.js')).toBe('something else')
})
