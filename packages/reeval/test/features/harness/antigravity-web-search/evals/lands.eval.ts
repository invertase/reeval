import { evaluate, expect } from 'reeval'
import { closed, prompt, searched } from './env.ts'

// Under deny-all, the agent searched with its web tool and the search succeeded: a search the
// gateway refused is still a web-search event, with ok false.
evaluate('lands', { environments: closed }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.status).toBe('completed')
  expect(turn).toHaveSearched(/antigravity/i)
  expect(searched(turn)).toContain(true)
})
