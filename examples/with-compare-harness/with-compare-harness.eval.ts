import { defineEnvironment, evaluate, expect } from 'reeval'
import { claudeCode, codex } from 'reeval/harness'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withJsdoc = math.extendEnvironment('jsdoc', ({ skill }) => ({
  skills: [skill.local('./skills/jsdoc')],
}))

evaluate(
  'documents the new function',
  {
    // The eval names its own agents, so every profile runs these two.
    harness: [claudeCode({ model: 'claude-sonnet-5' }), codex({ model: 'gpt-5.6-luna' })],
    compare: {
      variants: [withJsdoc],
      // Only Claude Code runs the variant; Codex runs the control alone.
      harness: ['claude-code:claude-sonnet-5'],
    },
    environment: math,
    // Pairs Claude Code's attempts with Codex's, in the same environment.
    questions: [{ question: 'Which multiply() is easier to read?', across: 'harness', diff: true }],
  },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')

    await expect(c.exec('node --test'), 'tests pass').toSucceed()
    await expect(c, 'JSDoc block').toHaveFile('src/math.js', /\*\/\s*export function multiply/)
  },
)
