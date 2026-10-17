import { evaluate, expect } from 'reeval'
import { LIMITS, plain } from './env.ts'

// docker({ memory, cpus, pids }) reach the container's cgroup.
evaluate('lands', { environment: plain }, async (c) => {
  expect((await c.exec(LIMITS)).stdout).toBe('536870912\n100000 100000\n256\n')
})
