import { evaluate, expect } from 'reeval'
import { agentSaw, tokens } from './env.ts'

// Must fail: the agent doesn't see what the checks see.
evaluate('canary', { environments: tokens }, async (c) => {
  const turn = await c.send('print CHECK_TOKEN')
  const checksSee = (await c.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(agentSaw(turn)).toBe(`${checksSee}\n`)
})
