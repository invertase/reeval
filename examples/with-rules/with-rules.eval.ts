import { defineEnvironment, evaluate, expect } from 'reeval'

// The small package in ./project, with ./rules.md written where the agent reads project rules
// (CLAUDE.md for Claude Code, AGENTS.md for the others).
const math = defineEnvironment('math', ({ directory, file }) => ({
  files: directory('./project'),
  rules: file('./rules.md'),
}))

evaluate('follows the project rules', { environments: math }, async (c) => {
  const turn = await c.send('Add a multiply(a, b) function to src/math.js.')

  expect(turn, 'runs the tests').toHaveRun(/npm test/)
  expect(await c.readFile('test/math.test.js'), 'adds a test').toContain('multiply')
  await expect(c.exec('npm test')).toSucceed()
})
