import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// The agent runs as its slot's user on the image's toolchain, with the install and the harness
// baked in: a slot's home is the image's copy, not an install of its own.
evaluate('lands', { environments: vm }, async (c) => {
  const [user, install, node, bootstrap] = agentSaw(await c.send('what is here'))
  expect(user).toMatch(/^reeval(-s1)?$/)
  expect(install).toBe('installed')
  expect(node).toBe('/opt/reeval/node/bin/node')
  expect(bootstrap).toBe('image')
})
