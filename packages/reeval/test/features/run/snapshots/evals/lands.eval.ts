import { evaluate, expect } from 'reeval'
import { snapshots } from './env.ts'

evaluate('lands', { environments: snapshots }, async (c) => {
  await c.send('build the app')
  expect(await c.readFile('app/built.js')).toContain('built')
})
