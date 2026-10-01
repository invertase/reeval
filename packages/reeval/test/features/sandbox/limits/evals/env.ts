import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker({ memory: '512m', cpus: 1, pids: 256 })
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const plain = defineEnvironment('plain', { sandbox })

/** Default docker() limits, for the canary. */
export const unlimited = defineEnvironment('unlimited', { sandbox: docker() })

/** The container's memory, CPU and process limits, as its cgroup has them. */
export const LIMITS = 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max'
