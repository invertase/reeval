import { defineEnvironment } from 'evalsuite'

export const plain = defineEnvironment('plain', {})

/** The container's memory, CPU and process limits, as its cgroup has them. */
export const LIMITS = 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max'
