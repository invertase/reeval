import { defineEnvironment, evaluate, expect } from 'reeval'

const review = defineEnvironment('review', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/review')],
}))
evaluate('places the plugin', { environments: review }, async (c) => {
  expect((await c.exec('cat ~/.reeval/plugins/review/agents/reviewer.md')).stdout).toContain(
    'Review',
  )
})
