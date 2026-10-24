import { defineEnvironment, evaluate, expect, group } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const calls = (call: string, want: number) =>
  `node -e "import('./src/math.js').then((m) => process.exit(m.${call} === ${want} ? 0 : 1))"`

group('math', { environment: math, tags: ['math'], timeout: '5m', runs: 2 }, () => {
  evaluate('adds multiply', async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')
    await expect(c.exec(calls('multiply(2, 3)', 6))).toSucceed()
  })

  evaluate('adds subtract', { runs: 1, tags: ['smoke'] }, async (c) => {
    await c.send('Add a subtract(a, b) function to src/math.js.')
    await expect(c.exec(calls('subtract(7, 3)', 4))).toSucceed()
  })

  evaluate.skip('adds divide', async (c) => {
    await c.send('Add a divide(a, b) function to src/math.js.')
    await expect(c.exec(calls('divide(8, 2)', 4))).toSucceed()
  })

  evaluate.todo('adds power')
})
