// `reeval/internal/vm`: reeval's own VM sandbox, not part of its public API. This module only
// describes the VMs; the run's main process starts them.
import { type CloudOptions, checkCloudOptions } from './contract/cloud.ts'
import { UsageError } from './errors.ts'
import type { CloudSandboxDescriptor } from './types.ts'

/** @internal */
export type { CloudOptions } from './contract/cloud.ts'
/** @internal */
export type { CloudMachineSize, CloudSandboxDescriptor } from './types.ts'

/**
 * One VM per attempt from the VM service at `REEVAL_VM_URL`, with the token in
 * `REEVAL_VM_TOKEN`. The agent, setup steps and checks run as an unprivileged user over SSH;
 * credentials stay on the host behind the egress gateway, as in Docker. Needs
 * `egress: 'allow-all'`.
 *
 * @internal Not part of reeval's public API; it may change or go away in any release.
 */
export function cloud(options: CloudOptions = {}): CloudSandboxDescriptor {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(`cloud() takes an options object (got ${JSON.stringify(options)})`)
  }
  checkCloudOptions(options)
  return { kind: 'cloud', ...structuredClone(options) }
}
