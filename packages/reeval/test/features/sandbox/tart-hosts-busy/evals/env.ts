import { defineEnvironment } from 'reeval'
import { tart } from 'reeval/sandbox'

// full looks roomier (two VMs to free's one), but its tart run refuses every VM as macOS does at
// its VM limit. One VM at a time: the fake VMs share this machine's loopback.
export const mac = defineEnvironment('mac', {
  sandbox: tart({
    image: 'ghcr.io/cirruslabs/macos-sequoia-base:15.6',
    hosts: ['full', { host: 'free', vms: 1 }],
    maxConcurrent: 1,
  }),
  egress: 'allow-all',
})
