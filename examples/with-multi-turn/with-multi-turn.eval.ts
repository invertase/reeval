import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const multipliesThree =
  'node -e "import(\'./src/math.js\').then((m) => process.exit(m.multiply(2, 3, 4) === 24 ? 0 : 1))"'

evaluate('extends multiply in a follow-up turn', { environment: math }, async (c) => {
  const first = await c.send(
    'Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js.',
  )
  await c.send('Now let multiply take any number of arguments: multiply(2, 3, 4) is 24.')

  await expect(c.exec(multipliesThree), 'takes three arguments').toSucceed()
  await expect(c.exec('node --test'), 'tests pass').toSucceed()
  expect(await c.judge('Does the test cover multiply(a, b)?', { on: first })).toPass()
  const kept = 'Over both turns, does multiply(a, b) keep working as the agent extends it?'
  expect(await c.judge(kept, { state: { turns: 'all' } })).toPass()
})
