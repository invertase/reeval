import { evaluate, expect } from 'reeval'
import { greeting, hidden } from './env.ts'

evaluate('canary', { environments: greeting }, async (c) => {
  await c.send('Create greet.js.')
  // Placed with c.exec, so the next turn's diff has it.
  await c.exec(`mkdir -p test && printf %s ${JSON.stringify(hidden)} > test/hidden.test.js`)
  await c.writeFile('.cache/grade.js', hidden)
  const turn = await c.send('Write notes.md.')
  expect(turn.diff.files.map((f) => f.path).sort()).toEqual(['greet.js', 'notes.md'])
})
