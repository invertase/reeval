import { evaluate, expect } from 'reeval'
import { placed, writable } from './env.ts'

// Under an engine whose exec starts at umask 0000, nothing reeval or the agent makes is
// group- or world-writable.
evaluate('lands', { environments: placed }, async (c) => {
  await c.send('make things')
  expect(await writable(c)).toEqual([])
})
