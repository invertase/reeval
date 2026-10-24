import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

// The small package in ./project, whose tests must pass before the agent starts.
const math = defineEnvironment('math', ({ directory }) => ({
  files: directory('./project'),
  setup: ['node --test'],
}))
// The same package plus the API conventions. Files merge by path; the setup steps run the
// parent's first.
const withDocs = math.extendEnvironment('math-with-docs', ({ file }) => ({
  files: { 'docs/api.md': file('./docs/api.md') },
  setup: ['test -f docs/api.md'],
}))

const hiddenTest = readFileSync(new URL('./hidden/multiply.test.js', import.meta.url), 'utf8')

evaluate('follows the API conventions', { environment: withDocs }, async (c) => {
  await c.send('Add a multiply(a, b) function to src/math.js. Follow docs/api.md.')

  await c.writeFile('test/multiply.test.js', hiddenTest)
  await expect(c.exec('node --test')).toSucceed()
})
