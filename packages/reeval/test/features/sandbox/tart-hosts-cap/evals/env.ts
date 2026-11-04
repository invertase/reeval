import { defineEnvironment, type Turn } from 'reeval'
import { tart } from 'reeval/sandbox'

// The plan counts both Macs' VMs, three; preflight skips small for its memory, which leaves one at
// a time. No maxConcurrent: the run's lease holds the second attempt until the first's VM ends.
export const mac = defineEnvironment('mac', {
  sandbox: tart({
    image: 'ghcr.io/cirruslabs/macos-sequoia-base:15.6',
    hosts: [{ host: 'mac-studio', vms: 1 }, 'small'],
  }),
  egress: 'allow-all',
})

/** What the scripted agent's shell command printed, one entry per line. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.split('\n') ?? []
