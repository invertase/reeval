import { evaluate, expect } from 'reeval'
import { installed } from './env.ts'

// A skill a setup step installed counts when the agent opens it, though reeval didn't place it.
evaluate('lands', { environments: installed }, async (c) => {
  const turn = await c.send('greet the crew')
  expect(turn).toHaveCalledSkill('house-greeting')
})
