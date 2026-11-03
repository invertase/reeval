import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'

const plain = defineEnvironment('plain', { sandbox: fakeSandbox() })
const withSkill = defineEnvironment('with-skill', { sandbox: fakeSandbox() })

// A pooled family whose second case holds a slash, compared against a named baseline.
evaluate.each(['add user authentication', 'add social login and email/password auth'])(
  'discovery: %s',
  { compare: { baseline: plain, variants: [withSkill] } },
  async (c, prompt) => {
    await c.send(prompt)
    await expect(c).toHaveFile('greet.js')
  },
)
