import { defineEnvironment, evaluate, expect } from 'reeval'

// The package in ./fixture without its maintainer notes, the orders data from ./data, and a
// .gitignore, since the project's own isn't copied in.
const orders = defineEnvironment('orders', ({ directory, file }) => ({
  files: {
    ...directory('./fixture', { glob: ['!NOTES.md'] }),
    'data/orders.csv': file('./data/orders.csv'),
    '.gitignore': 'node_modules/\n',
  },
}))

evaluate('summarises the orders', { environment: orders }, async (c) => {
  await c.send(
    'Write src/summary.js. It prints the number of orders in data/orders.csv and their total, ' +
      'like "3 orders, total 50.00".',
  )

  expect((await c.exec('node src/summary.js')).stdout).toBe('3 orders, total 50.00\n')
  expect(c, 'leaves the data alone').not.toHaveChanged(['data/**'])
})
