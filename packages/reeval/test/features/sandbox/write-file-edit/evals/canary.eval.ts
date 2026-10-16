import { evaluate, expect } from 'reeval'
import { greeting, hidden } from './env.ts'

evaluate('canary', { environment: greeting }, async (c) => {
  await c.send('Create greet.js.')
  await c.writeFile('test/hidden.test.js', hidden)
  await c.writeFile('.cache/grade.js', hidden)
  const turn = await c.send('Make the hidden test pass.')
  // Wrong: the agent's edit to a placed file is a modification, not a new file.
  const status = (path: string) => turn.diff.files.find((f) => f.path === path)?.status
  expect([status('test/hidden.test.js'), status('.cache/grade.js')]).toEqual(['added', 'modified'])
})
