import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

const slugify = defineEnvironment('slugify', ({ directory }) => ({ files: directory('./project') }))
const hiddenTest = readFileSync(new URL('./hidden/slugify.test.js', import.meta.url), 'utf8')

evaluate('implements slugify', { environments: slugify }, async (c) => {
  await c.send(
    'Implement slugify(text) in src/slugify.js: lower-case, words joined by single hyphens, ' +
      'punctuation dropped.',
  )

  // Placed after the turn, so the agent never sees the test it's graded by.
  await c.writeFile('test/slugify.test.js', hiddenTest)
  await expect(c.exec('node --test'), 'hidden tests pass').toSucceed()
})
