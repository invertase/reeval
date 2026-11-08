// `reeval/sandbox/hosted`: VMs on the reeval platform, for a hosted run. This module only describes
// them; the run's main process starts them through the platform's VM service.
import { checkHostedOptions, type HostedOptions } from './contract/hosted.ts'
import { UsageError } from './errors.ts'
import type { HostedSandboxDescriptor } from './types.ts'

export type { HostedOptions } from './contract/hosted.ts'
export type { HostedMachineSize, HostedSandboxDescriptor } from './types.ts'

/**
 * One VM per attempt on the reeval platform. It runs only inside a hosted run, which gives it
 * `REEVAL_VM_URL` and `REEVAL_VM_TOKEN`; the platform names, caps and removes the run's VMs. The
 * agent, setup steps and checks run as an unprivileged user over SSH; credentials stay on the
 * host behind the egress gateway, as in Docker. Needs `egress: 'allow-all'`.
 */
export function hosted(options: HostedOptions = {}): HostedSandboxDescriptor {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(`hosted() takes an options object (got ${JSON.stringify(options)})`)
  }
  checkHostedOptions(options)
  return { kind: 'hosted', ...structuredClone(options) }
}
