import { evaluate, expect } from 'reeval'

const head = process.env.REEVAL_COMPARE_SIDE === 'head'

// Cases whose double case is fixed on head: its build fails on base, so types never runs there.
evaluate(
  'adds a button that builds',
  { cases: [{ name: 'reset' }, { name: 'double' }, { name: 'clear' }] },
  async (c, { name }) => {
    await c.send(`Add a ${name} button.`)
    await expect(c.exec(head ? 'true' : `test ${name} != double`), 'build').toSucceed()
    await expect(c.exec('true'), 'types').toSucceed()
  },
)
