import { defineEnvironment, evaluate, expect } from 'reeval'

const plain = defineEnvironment('plain', {})
const withSkill = defineEnvironment('with-skill', {})

// A pooled family whose second case holds a slash, compared against a named baseline.
evaluate.each(['add user authentication', 'add social login and email/password auth'])(
  'discovery: %s',
  { compare: { baseline: plain, variants: [withSkill] } },
  async (c, prompt) => {
    await c.send(prompt)
    await expect(c).toHaveFile('greet.js')
  },
)
