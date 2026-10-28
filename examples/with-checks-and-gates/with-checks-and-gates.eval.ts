import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate('adds a divide function that refuses zero', { environment: math }, async (c) => {
  await c.send(
    'Add divide(a, b) to src/math.js. It throws a RangeError when b is 0. ' +
      'Test both cases in test/math.test.js.',
  )

  // A gate: the checks below mean nothing if src/math.js doesn't parse, so stop here.
  await expect.require(c.exec('node --check src/math.js'), 'parses').toSucceed()

  // Checks: a failed one is recorded and the eval carries on, so every requirement reports.
  await expect(c, 'exports divide').toHaveFile('src/math.js', /export function divide/)
  await expect(c, 'throws a RangeError').toHaveFile('src/math.js', /RangeError/)
  expect(await c.readFile('test/math.test.js'), 'tests divide').toContain('divide(')
  await expect(c.exec('node --test'), 'tests pass').toSucceed()
})
