import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project: src/duration.js, with no tests.
const duration = defineEnvironment('duration', ({ directory }) => ({
  files: directory('./project'),
}))
// src/duration.js with one bug planted: only the last unit counts, so '1h30m' is 30 minutes.
const mutant = readFileSync(new URL('./hidden/duration.js', import.meta.url), 'utf8')

evaluate('writes tests that catch a bug', { environment: duration }, async (c) => {
  await c.send('Write tests for src/duration.js in test/duration.test.js.')

  await expect(c.exec('node --test'), 'tests pass').toSucceed()
  await c.writeFile('src/duration.js', mutant)
  const mutated = await c.exec('node --test')
  expect(mutated.exitCode, 'the mutant fails them').not.toBe(0)
})
