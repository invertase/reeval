import { defineEnvironment, evaluate, expect, group } from 'reeval'

const plain = defineEnvironment('plain', {})
const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

// Only the variant greets in the house style, so that eval's control fails its check and its
// pairwise questions have no pairs; both arms write greet.js, so the second eval's first
// pairwise question has votes and its second fails at the model. Every attempt that ran is asked
// the last two on its own: one picks from choices, one answers in words. The first eval's
// labelled checks discriminate, or pass on both sides; the second's default-labelled check
// passes on both.
group(
  'house greeting',
  {
    compare: { baseline: plain, variants: [withHouseGreeting] },
    questions: [
      { question: 'Which greeting reads more like our house style?', across: 'environment' },
      { question: 'Which greeting handles a missing name?', across: 'environment' },
      { question: 'Does the greeting use the house style?', choices: ['yes', 'no'] },
      'How did the agent pick its greeting?',
    ],
  },
  () => {
    evaluate('greets in the house style', async (c) => {
      await c.send('Write greet.js that greets in our house style.')
      await expect.soft(c, 'writes greet.js').toHaveFile('greet.js')
      await expect(c.exec('grep -q Ahoy greet.js'), 'house greeting').toSucceed()
    })
    evaluate('writes a greeting', async (c) => {
      await c.send('Write greet.js that greets in our house style.')
      await expect(c).toHaveFile('greet.js')
    })
  },
)
