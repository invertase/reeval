import { defineEnvironment, evaluate, expect, group } from 'reeval'

const plain = defineEnvironment('plain', {})
const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

// Only the variant greets in the house style, so that eval's control fails its check and its
// question has no pairs; both arms write greet.js, so the second eval's question has votes.
group(
  'house greeting',
  {
    compare: {
      baseline: plain,
      variants: [withHouseGreeting],
      question: 'Which greeting reads more like our house style?',
    },
  },
  () => {
    evaluate('greets in the house style', async (t) => {
      await t.send('Write greet.js that greets in our house style.')
      await expect(t.exec('grep -q Ahoy greet.js')).toSucceed()
    })
    evaluate('writes a greeting', async (t) => {
      await t.send('Write greet.js that greets in our house style.')
      await expect(t).toHaveFile('greet.js')
    })
  },
)
