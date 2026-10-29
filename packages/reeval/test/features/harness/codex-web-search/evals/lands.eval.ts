import { evaluate, expect } from 'reeval'
import { closed, prompt } from './env.ts'

// Under deny-all, the agent searched with its web tool and the search came back: the transcript
// has the search and its query, and the answer names the repository it found.
evaluate('lands', { environment: closed }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.status).toBe('completed')
  expect(turn).toHaveSearched(/codex/i)
  expect(turn.text).toMatch(/github\.com\/openai\/codex/i)
})
