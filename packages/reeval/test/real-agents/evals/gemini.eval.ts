import { evaluate, expect } from 'reeval'
import { genkit } from './environments.ts'

// The Gemini key is brokered (see environments.ts): the agent's request carries a
// placeholder, and the gateway swaps the key in on the way to Google. Listing models is free, so
// this proves the key works end to end without paying for a generation. No judge.
evaluate(
  'the agent calls Gemini with a brokered key',
  { environment: genkit, tags: ['smoke', 'gemini'] },
  async (c) => {
    const turn = await c.send(
      'Run exactly this once, and reply with the number it prints only: ' +
        'curl -s -o /dev/null -w "%{http_code}" -H "x-goog-api-key: $GEMINI_API_KEY" ' +
        'https://generativelanguage.googleapis.com/v1beta/models',
    )
    expect(turn.status).toBe('completed')
    expect((await c.exec('printenv GEMINI_API_KEY')).stdout).toMatch(/^reeval_secret_/)
    const status = await c.exec(
      'curl -s -o /dev/null -w "%{http_code}" -H "x-goog-api-key: $GEMINI_API_KEY" https://generativelanguage.googleapis.com/v1beta/models',
    )
    expect(status.stdout).toBe('200')
  },
)
