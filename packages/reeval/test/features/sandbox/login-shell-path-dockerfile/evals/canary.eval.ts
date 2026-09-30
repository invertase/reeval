import { evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'
import { agentSaw, plain, TOOL } from './env.ts'

// Must fail: reeval's image without the Dockerfile doesn't have its tool on PATH.
evaluate('canary', { environment: plain, sandbox: docker({ id: 'docker' }) }, async (t) => {
  const [agent] = agentSaw(await t.send('find the tool'))
  expect(agent?.trim()).toBe(`${TOOL}\n${TOOL}`)
})
