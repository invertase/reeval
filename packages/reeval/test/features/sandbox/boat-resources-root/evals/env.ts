import { defineEnvironment } from 'reeval'
import { boat } from 'reeval/sandbox/boat'

export const vm = defineEnvironment('vm', { sandbox: boat(), egress: 'allow-all' })

/**
 * After the sampler has had time to start, as the sandbox user: `none` when no process is the
 * sampler (its script reads `/proc/meminfo`), else whether killing it worked. The bracket keeps
 * this command's own line from matching.
 */
export const FIND_SAMPLER = `sleep 3; p=$(grep -lsaE 'proc/meminf[o]' /proc/[0-9]*/cmdline | cut -d/ -f3); [ -z "$p" ] && echo none || { kill -9 $p 2>/dev/null && echo killed || echo refused; }`
