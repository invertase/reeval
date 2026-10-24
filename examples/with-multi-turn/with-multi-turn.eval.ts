import { defineEnvironment, evaluate, expect } from 'reeval'

// checks/call.mjs goes in the sandbox's home, outside the workspace and its diff.
const math = defineEnvironment('math', ({ directory, file }) => ({
  files: { ...directory('./project'), '~/checks/call.mjs': file('./checks/call.mjs') },
}))

evaluate('extends multiply in a follow-up turn', { environment: math }, async (c) => {
  const first = await c.send(
    'Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js.',
  )
  // Checks before the next c.send see the workspace as this turn left it.
  expect(first, 'turn 1 edited math.js').toHaveEdited('src/math.js')
  const two = await c.exec('node ~/checks/call.mjs multiply 2 3')
  expect(two.stdout.trim(), 'turn 1: multiply(2, 3)').toBe('6')

  const second = await c.send(
    'Now let multiply take any number of arguments: multiply(2, 3, 4) is 24.',
  )
  expect(second, 'turn 2 edited math.js').toHaveEdited('src/math.js')
  const three = await c.exec('node ~/checks/call.mjs multiply 2 3 4')
  expect(three.stdout.trim(), 'turn 2: multiply(2, 3, 4)').toBe('24')
  const twoStill = await c.exec('node ~/checks/call.mjs multiply 2 3')
  expect(twoStill.stdout.trim(), 'turn 2: multiply(2, 3) still').toBe('6')
  await expect(c.exec('node --test'), 'tests pass').toSucceed()
})
