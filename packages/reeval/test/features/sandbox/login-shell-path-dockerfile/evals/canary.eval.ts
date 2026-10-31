import { evaluate, expect } from 'reeval'
import { agentSaw, stock, TOOL } from './env.ts'

// Must fail: reeval's image without the Dockerfile doesn't have its tool on PATH.
evaluate('canary', { environments: stock }, async (c) => {
  const [agent] = agentSaw(await c.send('find the tool'))
  expect(agent?.trim()).toBe(`${TOOL}\n${TOOL}`)
})
