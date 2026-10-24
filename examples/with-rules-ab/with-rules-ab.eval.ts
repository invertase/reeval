import { defineEnvironment, evaluate, expect } from 'reeval'

// Two rules files for the same project. Each lands where the agent reads its rules (AGENTS.md,
// or CLAUDE.md for Claude Code).
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const shortRules = math.extendEnvironment('short-rules', ({ file }) => ({
  rules: file('./rules/short.md'),
}))
const detailedRules = math.extendEnvironment('detailed-rules', ({ file }) => ({
  rules: file('./rules/detailed.md'),
}))

evaluate(
  'records the change in the changelog',
  { compare: { baseline: shortRules, variants: [detailedRules] } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js.')

    await expect.soft(c.exec('node --test'), 'tests pass').toSucceed()
    await expect(c, 'changelog entry').toHaveFile('CHANGELOG.md', /## Unreleased\s+- feat: /)
  },
)
