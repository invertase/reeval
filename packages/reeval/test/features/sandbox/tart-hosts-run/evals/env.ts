import { defineEnvironment, type Turn } from 'reeval'
import { tart } from 'reeval/sandbox'

// Two Macs over SSH, and none of this machine's Tart. One VM at a time: the fake VMs share this
// machine's loopback, where each gateway's forwarder listens on the same port.
export const mac = defineEnvironment('mac', {
  sandbox: tart({
    image: 'ghcr.io/cirruslabs/macos-sequoia-base:15.6',
    hosts: ['mac-studio', 'elliot@mac-mini.local'],
    maxConcurrent: 1,
  }),
  egress: 'allow-all',
})

/** What the scripted agent's shell command printed, one entry per line. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.split('\n') ?? []
