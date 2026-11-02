import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate('adds multiply, then runs the tests', { environments: math }, async (c) => {
  const first = await c.send('Add a multiply(a, b) function to src/math.js, with a test.')
  expect(first).toHaveEdited('src/math.js')

  const second = await c.send('Now run the tests and tell me whether they pass.')
  expect(second).toHaveRun(/node --test|npm (test|t)\b/)
  await expect(c.exec('node --test')).toSucceed()
})
