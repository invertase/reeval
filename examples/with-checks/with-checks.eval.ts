import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate('adds a tested multiply function', { environment: math }, async (c) => {
  const turn = await c.send(
    'Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js.',
  )

  await expect(turn).toHaveFile('src/math.js', /export function multiply/)
  expect(await c.readFile('test/math.test.js')).toContain('multiply')
  await expect(c.exec('node --test')).toSucceed()
})
