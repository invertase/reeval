import { defineEnvironment } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

export const busy = defineEnvironment('busy', {
  sandbox: container({ memory: '512m', cpus: 1 }),
})

/** Holds 256 MiB and keeps one CPU busy for three seconds. */
export const BURN = `node -e 'const b = Buffer.alloc(256 << 20, 1); const t = Date.now(); while (Date.now() - t < 3000); console.log(b.length)'`

/** CPU seconds the container's cgroup has used so far. */
export const CPU_SECONDS = `echo $(( $(sed -n 's/^usage_usec //p' /sys/fs/cgroup/cpu.stat) / 1000000 ))`
