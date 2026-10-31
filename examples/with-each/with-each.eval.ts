import { defineEnvironment, evaluate, expect } from 'reeval'

// checks/call.mjs goes in the sandbox's home, outside the workspace and its diff.
const math = defineEnvironment('math', ({ directory, file }) => ({
  files: { ...directory('./project'), '~/checks/call.mjs': file('./checks/call.mjs') },
}))

const cases = [
  { fn: 'subtract', a: 7, b: 3, want: '4' },
  { fn: 'multiply', a: 2, b: 3, want: '6' },
  { fn: 'power', a: 2, b: 5, want: '32' },
]

evaluate.each(cases)('adds $fn to src/math.js', { environments: math }, async (c, item) => {
  await c.send(`Add a ${item.fn}(a, b) function to src/math.js.`)

  const run = await c.exec(`node ~/checks/call.mjs ${item.fn} ${item.a} ${item.b}`)
  expect(run).toSucceed()
  expect(run.stdout.trim()).toBe(item.want)
})
