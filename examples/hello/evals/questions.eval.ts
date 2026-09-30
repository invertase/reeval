import { evaluate, expect } from 'reeval'
import { plain, withHouseGreeting } from './environments.ts'
import { composer, pim } from './harnesses.ts'

// A compare question over two agents and two arms. Any greeting that names the person passes, so
// every attempt can be in a pair: within each harness the question compares the arms, and across
// harnesses it compares Cursor and pi on the same arm. The model sees only the diffs (not the
// skill), so the question asks about what they show. Its win rates annotate; the check gates.
// The nightly runs it with --profile questions (test/questions-real.test.ts).
const namesAda = `node -e "import('./greet.js').then((m) => {
  const greet = m.greet ?? m.default?.greet ?? m.default
  const out = String(greet('Ada'))
  console.log(out)
  process.exit(out.includes('Ada') ? 0 : 1)
})"`

evaluate(
  'greets by name',
  {
    tags: ['questions'],
    harness: [composer, pim],
    runs: 1,
    compare: {
      baseline: plain,
      variants: [withHouseGreeting],
      question: 'Which greet.js handles a missing or empty name better?',
    },
  },
  async (c) => {
    await c.send(
      'Create greet.js exporting greet(name) that greets the person in our house greeting style. ' +
        'Add a package.json with "type": "module". No dependencies.',
    )
    await expect(c.exec(namesAda)).toSucceed()
  },
)
