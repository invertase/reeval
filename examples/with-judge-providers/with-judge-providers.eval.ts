import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// Each judge calls its provider with that provider's own key. Set on the call, they win over
// any profile's judge.
const question = 'Would a new reader follow average, with the empty list handled on purpose?'

evaluate('adds a readable average function', { environment: math }, async (c) => {
  await c.send('Add an average(xs) function to src/math.js. It returns 0 for an empty list.')

  await expect(c).toHaveFile('src/math.js', /export function average/)
  await expect.require(c.exec('node --test')).toSucceed()
  const claude = await c.judge(question, { model: 'anthropic/claude-sonnet-5', diff: true })
  expect(claude, 'Claude agrees').toPass()
  const gemini = await c.judge(question, { model: 'google/gemini-3.8-flash', diff: true })
  expect(gemini, 'Gemini agrees').toPass()
})
