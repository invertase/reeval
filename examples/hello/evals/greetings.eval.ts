import { evaluate, expect } from 'reeval'
import { plain, withHouseGreeting } from './environments.ts'

// One task over a list of names, pooled into one suite. Each name is an eval with its own
// history, and the compare's lift is paired by name across all six, so `runs: 1` is enough for
// a verdict: minLift gates the pooled lower bound, not each name's.
const names = ['Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara']

evaluate.each(names)(
  'greets %s in the house style',
  {
    compare: {
      baseline: plain,
      variants: [withHouseGreeting],
      minLift: 0.2,
    },
  },
  async (c, name) => {
    await c.send('Create greet.js exporting greet(name) in our house style.')
    const check = `m.greet('${name}') === 'Ahoy, ${name}!' ? 0 : 1`
    await expect(
      c.exec(`node -e "import('./greet.js').then((m) => process.exit(${check}))"`),
    ).toSucceed()
  },
)
