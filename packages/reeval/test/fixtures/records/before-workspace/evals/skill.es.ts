import { defineEnvironment, evaluate, expect, group } from 'reeval'

const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

group('house greeting', { compare: { variants: [withHouseGreeting] } }, () => {
  evaluate('greets in the house style', async (t) => {
    await t.send('Write greet.js that greets in our house style.')
    await expect(t.exec('grep -q Ahoy greet.js')).toSucceed()
  })
})
