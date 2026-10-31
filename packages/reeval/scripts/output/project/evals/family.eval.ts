import { defineEnvironment, evaluate, expect } from 'reeval'

const plain = defineEnvironment('plain', {})
const withSkill = defineEnvironment('with-skill', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

// A family on one cell: a row per case, the failing one with its checks. A family with a
// change: the case outer, its arms inner, and the cases pooled into one effect.
evaluate.each([{ name: 'reset' }, { name: 'double' }, { name: 'clear' }])(
  'adds a $name button that builds',
  async (c, { name }) => {
    await c.send(`Add a ${name} button.`)
    await expect(c, 'writes greet.js').toHaveFile('greet.js')
    await expect.require(c.exec(`test ${name} != double`), 'build').toSucceed()
    await expect(c.exec('true'), 'types').toSucceed()
  },
)

evaluate.each(['Ada', 'Grace', 'Linus', 'Edsger'])(
  'greets %s in the house style',
  { compare: { control: plain, variants: [withSkill] } },
  async (c, name) => {
    await c.send(`Write greet.js that greets ${name} in our house style.`)
    await expect(c.exec('grep -q Ahoy greet.js'), 'house greeting').toSucceed()
  },
)
