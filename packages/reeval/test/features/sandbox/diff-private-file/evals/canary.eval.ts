import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('Store the key.')
  // Wrong: the agent's private directory is in the diff like any other.
  expect(turn.diff.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['added .token'])
})
