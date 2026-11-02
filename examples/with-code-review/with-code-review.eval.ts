import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project, where page() has an off-by-one.
const app = defineEnvironment('search', ({ directory }) => ({ files: directory('./project') }))

evaluate('finds the planted bug without editing', { environments: app }, async (c) => {
  await c.send('Review the code in src/ for bugs and reply with what you find. Do not edit files.')

  expect(c, 'no edits').not.toHaveChanged()
  const question = 'Does the review find that page() is off by one, so page 1 skips items?'
  expect(await c.judge(question, { output: true })).toPass()
})
