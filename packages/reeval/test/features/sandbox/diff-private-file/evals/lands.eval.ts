import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// The snapshot's git reads files the agent kept to itself, though the agent can't read its git dir.
evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send('Store the key.')
  expect(turn.diff.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
    'added .token',
    'added private/key',
  ])
})
