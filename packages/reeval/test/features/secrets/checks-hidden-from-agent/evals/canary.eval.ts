import { evaluate, expect } from 'evalsuite'
import { agentSaw, tokens } from './env.ts'

// Must fail: the agent doesn't see what the checks see.
evaluate('canary', { environment: tokens }, async (t) => {
  const turn = await t.send('print CHECK_TOKEN')
  const checksSee = (await t.exec('printf %s "$CHECK_TOKEN"')).stdout
  expect(agentSaw(turn)).toBe(`${checksSee}\n`)
})
