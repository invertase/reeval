import { evaluate, expect } from 'reeval'
import { agentSaw, plain, TOOL } from './env.ts'

// A Dockerfile's `ENV PATH` on reeval's image survives /etc/profile in the agent's login shells.
evaluate('lands', { environment: plain }, async (c) => {
  const [agent] = agentSaw(await c.send('find the tool'))
  expect(agent?.trim()).toBe(`${TOOL}\n${TOOL}`)
})
