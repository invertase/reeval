import { evaluate, expect } from 'evalsuite'
import { closed, prompt, references } from './env.ts'

// Under deny-all, the agent searched with its web tool and the search came back with results:
// the transcript has the search, its query and how many pages it found.
evaluate('lands', { environment: closed }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn.status).toBe('completed')
  expect(turn).toHaveSearched(/opencode/i)
  expect(Math.max(0, ...references(turn))).toBeGreaterThan(0)
})
