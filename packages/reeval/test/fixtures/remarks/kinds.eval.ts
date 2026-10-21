import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'

evaluate('adds a cache', async (c) => {
  await c.send('Remove the debug logging from server.ts.')
  expect(true, 'logging removed').toBe(true)
})

evaluate('test 1', async (c) => {
  await c.send('Write a greeting to hello.txt.')
  expect(true, 'wrote it').toBe(true)
})

evaluate('answers kindly', async (c) => {
  await c.send('Thank the user and suggest a next step.')
  expect(await c.judge('Is the answer okay?')).toPass()
})

evaluate('finds the bug', async (c) => {
  await c.send('The parser test fails. Find out why.')
  expect(await c.judge('Does it say the bug is the off-by-one in parse()?')).toPass()
})

evaluate('ships the release', { judge: { model: fakeJudge({ score: 0.2 }) } }, async (c) => {
  await c.send('Fix the date bug, add a test and update the changelog.')
  expect.soft(await c.judge('Does it fix the bug, add a test and update the changelog?')).toPass()
})

evaluate('picks Genkit', async (c) => {
  await c.send('Build a chat agent in TypeScript with Genkit.')
  expect(true, 'built it').toBe(true)
})

evaluate('adds dark mode', async (c) => {
  await c.send('Add a dark mode toggle to the settings page.')
  expect(true, 'toggle added').toBe(true)
})
