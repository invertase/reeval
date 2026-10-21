import { defineEnvironment, evaluate, expect } from 'reeval'

const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\n' } })
evaluate(
  'uses the marker with the marked skill',
  { runs: 2, compare: { baseline: plain, variants: [marked] } },
  async (c) => {
    await c.send('go')
    const wins = c.attempt.cell.role === 'variant' ? 2 : 0
    expect.soft(c.attempt.n <= wins, 'uses the marker').toBe(true)
  },
)
