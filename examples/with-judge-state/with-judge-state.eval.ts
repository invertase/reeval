import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project, README.md included.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate('lists the new function in the README', { environment: math }, async (c) => {
  await c.send('Add a multiply(a, b) function to src/math.js, and list it in README.md.')

  await expect(c).toHaveFile('src/math.js', /export function multiply/)
  await expect(c.exec('node --test')).toSucceed()
  const verdict = await c.judge('Does README.md list every function src/math.js exports?', {
    state: { diff: ['src/**'], contents: ['README.md'], transcript: 'tools' },
  })
  expect(verdict).toPass()
})
