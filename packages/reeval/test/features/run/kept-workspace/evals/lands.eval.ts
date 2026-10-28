import { evaluate, expect } from 'reeval'
import { keptWorkspace } from './env.ts'

evaluate('lands', { environment: keptWorkspace }, async (c) => {
  await c.send('build the app')
  expect(await c.readFile('app/built.js')).toContain('built')
})
