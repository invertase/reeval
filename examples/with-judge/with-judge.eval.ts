import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate('adds divide with a helpful error', { environment: math }, async (c) => {
  await c.send(
    'Add a divide(a, b) function to src/math.js. When b is 0 it throws, with a message ' +
      'that tells the caller what went wrong.',
  )

  await expect(c).toHaveFile('src/math.js', /export function divide/)
  await expect(c.exec('node --test')).toSucceed()
  const verdict = await c.judge(
    'Would the error divide throws when b is 0 tell a caller what they did wrong?',
    { diff: true },
  )
  expect(verdict).toPass()
})
