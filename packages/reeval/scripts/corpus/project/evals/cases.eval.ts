import { defineEnvironment, evaluate, expect } from 'reeval'

const plain = defineEnvironment('plain', {})
const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

// Pooled cases: only the variant greets with Ahoy, so every case is a discordant pair and the
// record has a family with rates and a paired lift.
evaluate(
  'greets',
  {
    cases: ['Ada', 'Grace'],
    compare: { control: plain, variants: [withHouseGreeting], minLift: 0.2 },
  },
  async (c, name) => {
    await c.send(`Write greet.js that greets ${name} in our house style.`)
    await expect(c.exec('grep -q Ahoy greet.js')).toSucceed()
  },
)
