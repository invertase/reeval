import { evaluate, expect } from 'reeval'

const head = process.env.REEVAL_COMPARE_SIDE === 'head'

// A family whose double case is fixed on head: its build fails on base, so types never runs there.
evaluate.each([{ name: 'reset' }, { name: 'double' }, { name: 'clear' }])(
  'adds a $name button that builds',
  async (c, { name }) => {
    await c.send(`Add a ${name} button.`)
    await expect(c.exec(head ? 'true' : `test ${name} != double`), 'build').toSucceed()
    await expect(c.exec('true'), 'types').toSucceed()
  },
)
