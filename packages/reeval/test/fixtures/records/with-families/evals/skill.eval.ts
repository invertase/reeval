import { defineEnvironment, evaluate, expect, group } from 'reeval'

const plain = defineEnvironment('plain', {})
const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

// Only the variant greets in the house style, so that eval's control fails its check and its
// questions have no pairs; both arms write greet.js, so the second eval's first question has
// votes and its second fails at the model.
group(
  'house greeting',
  {
    compare: {
      baseline: plain,
      variants: [withHouseGreeting],
      questions: [
        'Which greeting reads more like our house style?',
        'Which greeting handles a missing name?',
      ],
    },
  },
  () => {
    evaluate('greets in the house style', async (c) => {
      await c.send('Write greet.js that greets in our house style.')
      await expect(c.exec('grep -q Ahoy greet.js')).toSucceed()
    })
    evaluate('writes a greeting', async (c) => {
      await c.send('Write greet.js that greets in our house style.')
      await expect(c).toHaveFile('greet.js')
    })
  },
)
