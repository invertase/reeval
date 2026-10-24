import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project: orders.csv, three orders totalling 50.
const orders = defineEnvironment('orders', ({ directory }) => ({ files: directory('./project') }))

evaluate('summarises the orders', { environment: orders }, async (c) => {
  await c.send('Write summary.js. It prints how many orders orders.csv has, and their total.')

  const run = await c.exec('node summary.js')
  expect(run.exitCode).toBe(0)
  const verdict = await c.judge('Does it say there are 3 orders totalling 50?', {
    on: run.stdout,
  })
  expect(verdict).toPass()
})
