import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

// The same convention two ways: as a skill, and as a docs file in the workspace.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withSkill = math.extendEnvironment('errors-skill', ({ skill }) => ({
  skills: [skill.local('./skills/errors')],
}))
const withDoc = math.extendEnvironment('errors-doc', ({ file }) => ({
  files: { 'docs/errors.md': file('./docs/errors.md') },
}))
const divideTest = readFileSync(new URL('./hidden/divide.test.js', import.meta.url), 'utf8')

evaluate(
  'rejects division by zero',
  // A study: no arm gates, so a variant that misses reports without failing the run.
  { compare: { baseline: math, variants: [withSkill, withDoc], gate: 'none' } },
  async (c) => {
    await c.send('Add a divide(a, b) function to src/math.js.')

    await c.writeFile('test/divide.test.js', divideTest)
    await expect(c.exec('node --test'), 'throws RangeError').toSucceed()
  },
)
