import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate('adds a divide function that refuses zero', { environment: math }, async (c) => {
  await c.send(
    'Add divide(a, b) to src/math.js. It throws a RangeError when b is 0. ' +
      'Test both cases in test/math.test.js.',
  )

  await expect.soft(c, 'exports divide').toHaveFile('src/math.js', /export function divide/)
  await expect.soft(c, 'throws a RangeError').toHaveFile('src/math.js', /RangeError/)
  expect.soft(await c.readFile('test/math.test.js'), 'tests divide').toContain('divide(')
  await expect.soft(c.exec('node --test'), 'tests pass').toSucceed()
})
