// Sandbox providers' VM APIs through their own SDKs, behind one interface, importing no Node
// built-in. SSH to the machines is the caller's. Each provider's adapter is its own
// entry (`./boat`, `./daytona`), whose types come from that provider's SDK; this one needs neither.
export { retryAtOf, VmApiError, type VmErrorKind } from './errors.ts'
export type {
  CreateVm,
  ExecResult,
  ProcessStatus,
  SshAccess,
  SshRoute,
  VmApi,
  VmCapabilities,
  VmInfo,
  VmLimits,
  VmProviderId,
  VmState,
} from './types.ts'
export { removeUntilGone, VmNotReady, waitReady } from './wait.ts'
