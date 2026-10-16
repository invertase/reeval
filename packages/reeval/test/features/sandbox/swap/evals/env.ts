import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'

export const plain = defineEnvironment('plain', {
  sandbox: docker({ memory: '512m', swap: '256m' }),
})

/** Default swap, as much as memory, for the canary. */
export const doubled = defineEnvironment('doubled', { sandbox: docker({ memory: '512m' }) })

/** The swap the container may use on top of its memory, as its cgroup has it. */
export const SWAP = 'cat /sys/fs/cgroup/memory.swap.max'
