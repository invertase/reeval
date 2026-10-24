import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withErrors = math.extendEnvironment('errors', ({ skill }) => ({
  skills: [skill.local('./skills/errors')],
}))
const divideTest = readFileSync(new URL('./hidden/divide.test.js', import.meta.url), 'utf8')

evaluate(
  'rejects division by zero',
  {
    compare: { baseline: math, variants: [withErrors] },
    // across makes it pairwise: asked of every pair of arms whose attempts passed their
    // checks. It never gates.
    questions: [
      {
        question: 'Which divide() says more clearly what went wrong when b is 0?',
        across: 'environment',
      },
    ],
  },
  async (c) => {
    await c.send('Add a divide(a, b) function to src/math.js. It must throw when b is 0.')

    await c.writeFile('test/divide.test.js', divideTest)
    await expect(c.exec('node --test'), 'throws for 0').toSucceed()
  },
)
