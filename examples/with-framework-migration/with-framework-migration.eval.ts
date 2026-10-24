import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project, a CommonJS package with node:test tests.
const cjs = defineEnvironment('commonjs', ({ directory }) => ({ files: directory('./project') }))

evaluate('migrates the package to ES modules', { environment: cjs }, async (c) => {
  const turn = await c.send(
    'Migrate this package from CommonJS to ES modules. Keep npm test green.',
  )

  await expect(c).toHaveFile('package.json', /"type":\s*"module"/)
  const leftovers = await c.exec("grep -rnE 'require\\(|module\\.exports' src test || true")
  expect(leftovers.stdout, 'no CommonJS left').toBe('')
  await expect(c.exec('npm test')).toSucceed()
  expect(turn, 'ran the tests').toHaveRun(/npm (test|t)\b|node --test/)
})
