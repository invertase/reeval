import { defineEnvironment, evaluate, expect } from 'reeval'

const plain = defineEnvironment('plain', {})
const withSkill = defineEnvironment('with-skill', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))
const withDoc = defineEnvironment('with-doc', {
  files: { 'docs/house-style.md': 'Our house greeting is "Ahoy, <name>!".\n' },
})

// Measure a change: the skill helps, the doc makes no difference, and with 4 tries an arm the
// effort table prints because the eval failed. The second eval's skill makes it worse; the
// third has 1 try an arm, so its effect can't be told yet.
evaluate(
  'greets in the house style',
  { runs: 4, compare: { baseline: plain, variants: [withSkill, withDoc] } },
  async (c) => {
    await c.send('Write greet.js that greets in our house style.')
    await expect.soft(c, 'writes greet.js').toHaveFile('greet.js')
    await expect(c.exec('grep -q Ahoy greet.js'), 'house greeting').toSucceed()
    await expect(c.exec('grep -q "!" greet.js'), 'exclaims').toSucceed()
  },
)

evaluate(
  'keeps the plain greeting',
  { runs: 4, compare: { baseline: plain, variants: [withSkill] } },
  async (c) => {
    await c.send('Write greet.js that says Hello.')
    await expect(c.exec('grep -q Hello greet.js'), 'says hello').toSucceed()
  },
)

evaluate('greets once', { compare: { baseline: plain, variants: [withSkill] } }, async (c) => {
  await c.send('Write greet.js that greets in our house style.')
  await expect(c.exec('grep -q Ahoy greet.js'), 'house greeting').toSucceed()
})
