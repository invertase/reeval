import { evaluate, expect } from 'reeval'
import { installed } from './env.ts'

// Must fail: the setup step installed house-farewell too, but the agent never opened it.
evaluate('canary', { environments: installed }, async (c) => {
  const turn = await c.send('greet the crew')
  expect(turn).toHaveCalledSkill('house-farewell')
})
