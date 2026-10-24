import { defineEnvironment, evaluate, expect } from 'reeval'

const plain = defineEnvironment('plain', {})
const withSkill = plain.extendEnvironment('house-style', ({ skill }) => ({
  skills: [skill.local('./skills/house-style')],
}))

// The house style can't be guessed, so only an agent that read the skill writes "Ahoy".
const greetsAda = `node -e "import('./greet.js').then((m) =>
  process.exit((m.greet ?? m.default)('Ada') === 'Ahoy, Ada!' ? 0 : 1))"`

evaluate(
  'greets in the house style',
  // Four tries a side is the fewest that gives a verdict; the variant passes on 3 of 4 or more.
  { compare: { baseline: plain, variants: [withSkill] }, runs: 4, gate: { passRate: 0.75 } },
  async (c) => {
    await c.send(
      'Create greet.js exporting greet(name) that greets the person in our house style. ' +
        'Add a package.json with "type": "module". No dependencies.',
    )
    // Both arms usually pass this one; the summary shows the house greeting tells them apart.
    await expect.soft(c, 'exports greet').toHaveFile('greet.js', /export/)
    await expect(c.exec(greetsAda), 'house greeting').toSucceed()
  },
)
