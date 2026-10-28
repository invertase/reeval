import { defineEnvironment, evaluate, expect, group } from 'reeval'

const plain = defineEnvironment('plain', {})
const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

// Both arms write greet.js, so the first pairwise question has votes and the second fails at the
// model. Each attempt is asked the last two on its own: one picks from choices, one answers in
// words. One check is labeled and one keeps its default label.
group(
  'house greeting',
  {
    compare: { baseline: plain, variants: [withHouseGreeting] },
    questions: [
      {
        question: 'Which greeting reads more like our house style?',
        across: 'environment',
        diff: true,
      },
      { question: 'Which greeting handles a missing name?', across: 'environment', diff: true },
      { question: 'Does the greeting use the house style?', choices: ['yes', 'no'], diff: true },
      'How did the agent pick its greeting?',
    ],
  },
  () => {
    evaluate('writes a greeting', async (c) => {
      await c.send('Write greet.js that greets in our house style.')
      await expect(c, 'writes greet.js').toHaveFile('greet.js')
      await expect(c).toHaveFile('greet.js')
    })
  },
)
