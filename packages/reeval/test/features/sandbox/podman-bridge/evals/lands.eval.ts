import { evaluate, expect } from 'reeval'
import { ADDRESSES, bridged, bridgeSubnets, within } from './env.ts'

// podman() puts the sandbox on the `podman` bridge, the one network a restricted policy can
// detach it from: its address is in that network's subnet.
evaluate('lands', { environment: bridged }, async (c) => {
  const addresses = (await c.exec(ADDRESSES)).stdout.trim().split('\n')
  expect(within(addresses, bridgeSubnets())).toHaveLength(1)
})
