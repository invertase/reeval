import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))
const withLayout = math.extendEnvironment('project-layout', ({ skill }) => ({
  skills: [skill.local('./skills/project-layout')],
}))

evaluate(
  'adds a tested multiply function',
  // Effort's rank test needs four tries a side to reach a verdict; each arm may miss one.
  { compare: { control: math, variants: [withLayout] }, runs: 4, gate: { passRate: 0.75 } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js, with a test.')

    expect(await c.readFile('test/math.test.js')).toContain('multiply')
    await expect(c.exec('node --test')).toSucceed()
  },
)
