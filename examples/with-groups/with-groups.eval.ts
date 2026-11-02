import { defineEnvironment, evaluate, expect, group } from 'reeval'

// checks/call.mjs goes in the sandbox's home, outside the workspace and its diff.
const math = defineEnvironment('math', ({ directory, file }) => ({
  files: { ...directory('./project'), '~/checks/call.mjs': file('./checks/call.mjs') },
}))

group(
  'math',
  // Two runs a cell, passing when one of them does: the default gate would need both.
  { environments: math, tags: ['math'], timeout: '5m', runs: 2, gate: { passRate: 0.5 } },
  () => {
    evaluate('adds multiply', async (c) => {
      await c.send('Add a multiply(a, b) function to src/math.js.')
      expect((await c.exec('node ~/checks/call.mjs multiply 2 3')).stdout.trim()).toBe('6')
    })

    evaluate('adds subtract', { runs: 1, tags: ['smoke'] }, async (c) => {
      await c.send('Add a subtract(a, b) function to src/math.js.')
      expect((await c.exec('node ~/checks/call.mjs subtract 7 3')).stdout.trim()).toBe('4')
    })

    evaluate.skip('adds divide', async (c) => {
      await c.send('Add a divide(a, b) function to src/math.js.')
      expect((await c.exec('node ~/checks/call.mjs divide 8 2')).stdout.trim()).toBe('4')
    })

    evaluate.todo('adds power')
  },
)
