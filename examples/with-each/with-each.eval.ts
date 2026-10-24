import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

const cases = [
  { fn: 'subtract', a: 7, b: 3, want: 4 },
  { fn: 'multiply', a: 2, b: 3, want: 6 },
  { fn: 'power', a: 2, b: 5, want: 32 },
]

evaluate.each(cases)('adds $fn to src/math.js', { environment: math }, async (c, item) => {
  await c.send(`Add a ${item.fn}(a, b) function to src/math.js.`)

  const call = `m.${item.fn}(${item.a}, ${item.b})`
  const run = await c.exec(`node -e "import('./src/math.js').then((m) => console.log(${call}))"`)
  await expect(run).toSucceed()
  expect(run.stdout.trim()).toBe(String(item.want))
})
