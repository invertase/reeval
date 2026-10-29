import { evaluate, expect } from 'reeval'
import { closed, prompt } from './env.ts'

// Under deny-all, the agent searched with its web tool and the transcript has the search and its
// query. Codex leaves a search the gateway refused out of its stream, and the model names the
// repository from memory either way, so the search event is the check.
evaluate('lands', { environment: closed }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.status).toBe('completed')
  expect(turn).toHaveSearched(/codex/i)
})
