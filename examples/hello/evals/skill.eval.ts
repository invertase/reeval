import { evaluate, expect, group } from 'reeval'
import { plain, withHouseGreeting } from './environments.ts'

// The core AX comparison: the same task with and without a skill. The house style can't be
// guessed, so only the variant should pass. The baseline isn't gated: it's expected to fail,
// and the run reports its lift instead.
const greetAda = `node -e "import('./greet.js').then((m) => {
  const greet = m.greet ?? m.default?.greet ?? m.default
  const out = greet('Ada')
  console.log(out)
  process.exit(out === 'Ahoy, Ada!' ? 0 : 1)
})"`

group(
  'house greeting',
  // Without its variant the question is meaningless, so a profile can't turn compare off here.
  // The question is asked after the run of the attempts that passed their checks: when the
  // baseline misses, as expected, there's no pair to judge and the answer says so.
  {
    compare: {
      baseline: plain,
      variants: [withHouseGreeting],
      question: 'Which greet.js reads more like our house style?',
    },
    pin: ['compare'],
  },
  () => {
    evaluate('greets in the house style', async (c) => {
      await c.send(
        'Create greet.js exporting greet(name) that greets the person in our house greeting style. ' +
          'Add a package.json with "type": "module". No dependencies.',
      )
      await expect(c.exec(greetAda)).toSucceed()
    })
  },
)
