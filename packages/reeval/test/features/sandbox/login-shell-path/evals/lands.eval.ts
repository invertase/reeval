import { evaluate, expect } from 'reeval'
import { agentSaw, plain, TOOL } from './env.ts'

// A `from` image's `ENV PATH` survives Debian's /etc/profile in the agent's login shells.
evaluate('lands', { environment: plain }, async (t) => {
  const [agent] = agentSaw(await t.send('find the tool'))
  expect(agent?.trim()).toBe(`${TOOL}\n${TOOL}`)
})
