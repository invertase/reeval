import { evaluate, expect } from 'reeval'
import { agentSaw, plain } from './env.ts'

// Must fail: Podman's own seccomp profile would let the unshare through.
evaluate('canary', { environment: plain }, async (c) => {
  const [agent] = agentSaw(await c.send('unshare'))
  expect(agent?.trim()).toBe('exit=0')
})
