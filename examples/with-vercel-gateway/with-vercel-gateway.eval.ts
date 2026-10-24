import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// On Vercel AI Gateway, Jev is the judge that answers: the other models there are language
// models, not decision models. Set on the eval, it wins over any profile's judge.
const jev = { model: 'typesafe-ai/jev-1.14.0' }

evaluate('adds a tested multiply function', { environment: math, judge: jev }, async (c) => {
  await c.send('Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js.')

  await expect(c.exec('node --test')).toSucceed()
  const verdict = await c.judge('Does the new test check multiply, not add?')
  expect(verdict).toPass()
})
