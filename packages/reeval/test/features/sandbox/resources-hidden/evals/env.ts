import { defineEnvironment } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

export const watched = defineEnvironment('watched', {
  sandbox: container({ memory: '512m', cpus: 1 }),
})

/**
 * After the sampler has had time to start, as the sandbox user: `none` when no process here is
 * the sampler (its script reads `memory.stat`'s `inactive_file`), else whether killing it worked:
 * `refused` for root's fallback in the container, `killed` for one the sandbox user owns. The
 * bracket keeps this command's own line from matching.
 */
export const FIND_SAMPLER = `sleep 3; p=$(grep -lsaE 'inactive_fil[e]' /proc/[0-9]*/cmdline | cut -d/ -f3); [ -z "$p" ] && echo none || { kill -9 $p 2>/dev/null && echo killed || echo refused; }`
