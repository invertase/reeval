import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

// sindresorhus/camelcase at a release tag: no dependencies, and node --test runs its own tests.
const camelcase = defineEnvironment('camelcase', ({ git }) => ({
  workspace: git('github:sindresorhus/camelcase', { ref: 'v10.0.0', init: true }),
}))
const hidden = readFileSync(new URL('./hidden/separators.test.js', import.meta.url), 'utf8')

evaluate('adds a separators option', { environment: camelcase }, async (c) => {
  await c.send(
    'Add a separators option to camelCase: a string of extra characters that also separate ' +
      "words, so camelCase('foo/bar', {separators: '/'}) is 'fooBar'. Add tests to test.js and " +
      'document it in readme.md. Run the tests with node --test.',
  )

  await expect(c.exec('node --test'), "the repo's tests pass").toSucceed()
  await expect(c).toHaveFile('readme.md', /separators/)
  await c.writeFile('separators.test.js', hidden)
  await expect(c.exec('node --test separators.test.js'), 'the option works').toSucceed()
})
