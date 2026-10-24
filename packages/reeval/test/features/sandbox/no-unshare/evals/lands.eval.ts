import { evaluate, expect } from 'reeval'
import { agentSaw, plain } from './env.ts'

// Docker's default seccomp profile, which podman() ships and passes too, refuses the agent a
// namespace of its own.
evaluate('lands', { environment: plain }, async (c) => {
  const [agent] = agentSaw(await c.send('unshare'))
  expect(agent?.trim()).toBe('unshare: unshare failed: Operation not permitted\nexit=1')
})
