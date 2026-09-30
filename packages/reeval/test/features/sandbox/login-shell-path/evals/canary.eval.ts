import { evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'
import { agentSaw, plain, TOOL } from './env.ts'

// Must fail: reeval's own image doesn't have the `from` image's tool on PATH.
evaluate('canary', { environment: plain, sandbox: docker({ id: 'docker' }) }, async (c) => {
  const [agent] = agentSaw(await c.send('find the tool'))
  expect(agent?.trim()).toBe(`${TOOL}\n${TOOL}`)
})
