import { evaluate, expect } from 'reeval'
import { agentSaw, loud } from './env.ts'

// Must fail: without NODE_OPTIONS, the image's Node 22 warns that EnvHttpProxyAgent is experimental.
evaluate('canary', { environment: loud }, async (c) => {
  const [output] = agentSaw(await c.send('fetch the listener with node'))
  expect(output?.trim()).toBe('reeval-egress-ok')
})
