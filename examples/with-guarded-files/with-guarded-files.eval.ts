import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

evaluate('adds clamp without new dependencies', { environments: math }, async (c) => {
  await c.send(
    'Add clamp(n, min, max) to src/math.js, with a test in test/math.test.js. ' +
      'Add no dependencies.',
  )

  expect(c, 'dependencies untouched').not.toHaveChanged(['package.json', 'package-lock.json'])
  await expect(c.exec('node --test'), 'tests pass').toSucceed()
})
