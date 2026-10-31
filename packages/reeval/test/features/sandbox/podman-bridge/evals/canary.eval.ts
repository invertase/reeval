import { evaluate, expect } from 'reeval'
import { ADDRESSES, bridged, within } from './env.ts'

// Must fail: rootless Podman's default network, slirp4netns, would put the sandbox at 10.0.2.100.
evaluate('canary', { environments: bridged }, async (c) => {
  const addresses = (await c.exec(ADDRESSES)).stdout.trim().split('\n')
  expect(within(addresses, ['10.0.2.0/24'])).toHaveLength(1)
})
