/** The providers this package speaks to. */
export type VmProviderId = 'boat' | 'daytona'

/**
 * Where a machine is in its life: `starting` until it takes commands, `ready` while it does, and
 * `dead` once it never will again (failed, stopped, archived or being deleted).
 */
export type VmState = 'starting' | 'ready' | 'dead'

export type VmInfo = {
  id: string
  name: string
  state: VmState
  /** The provider's own state, as it named it. */
  raw: string
  /** Why it failed, when the provider said. */
  error?: string
  labels: Record<string, string>
  /** How long it lives from its last create or TTL change, as the provider granted it. */
  ttlSeconds?: number
}

export type CreateVm = {
  name: string
  /** The provider's machine type (Boat) or size (Daytona's default snapshot). */
  size: string
  labels: Record<string, string>
  /** How long it may live; the provider deletes it after. Daytona rounds up to whole minutes. */
  ttlSeconds: number
  /** Makes a retried create return the first machine; providers without it ignore it. */
  idempotencyKey?: string
  /** Every command's environment, kept out of command lines. */
  env?: Record<string, string>
  /** The image or snapshot to start from, rather than the provider's base for `size`. */
  from?: string
  /** Whether the machine can be saved as an image ({@link VmCapabilities.images} `save-vm`). */
  saveable?: boolean
}

/** A host and port that reaches the machine's SSH server. */
export type SshRoute = { host: string; port: number; via: string }

export type SshAccess = {
  /** The login user; on Daytona, a token that is the credential itself. */
  user: string
  /** Where its SSH server answers, best first. */
  routes: SshRoute[]
  /** The server's host key as a known_hosts key (`ssh-ed25519 AAAA…`), when the provider gives it. */
  hostKey?: string
  /** `key`: the public key sent is authorized. `token`: the user alone logs in, with no key. */
  auth: 'key' | 'token'
}

/** What a provider will still start for the account. */
export type VmLimits = {
  canStart: boolean
  blockedReason?: string
  live: number
  maxLive: number
  startsPerMinute?: number
  startsPerHour?: number
  startsThisHour?: number
  /** Each machine type and whether the account may start it. */
  sizes?: Array<{ size: string; available: boolean; reason?: string }>
  /** How the service lays an account's machines out, as it sent it, when it sends one. */
  layout?: unknown
}

export type ExecResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type ProcessStatus = {
  status: 'running' | 'exited' | 'lost'
  running: boolean
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

/** What a provider can do, checked before relying on it. */
export type VmCapabilities = {
  /** `create` takes `env`. */
  envAtCreate: boolean
  /** `exec`, `spawn` and `status` run commands through the API, without SSH. */
  processes: boolean
  /** The longest `exec` the API waits on; longer work goes through `spawn`. */
  maxExecSeconds: number | null
  /** The TTL's unit: Daytona's is whole minutes. */
  ttl: 'seconds' | 'minutes'
  /** `list` filters by label on the provider's side. */
  labelFilter: boolean
  /** `list` filters by name prefix on the provider's side; else this package filters. */
  namePrefixFilter: boolean
  /** `create` honors `idempotencyKey`. */
  idempotentCreate: boolean
  /** `sshAccess` gives the host key, so the client needn't scan it. */
  sshHostKey: boolean
  /** `limits` answers. Without it, only a refused start says the account is full. */
  limits: boolean
  /** How a machine becomes an image: saving a VM, building a Dockerfile, or not at all. */
  images: 'save-vm' | 'build-dockerfile' | 'none'
  /** The sizes `create` takes. */
  sizes: readonly string[]
}

export interface VmApi {
  provider: VmProviderId
  capabilities: VmCapabilities
  /** Starts a machine; it reports `starting` until it's ready (see `waitReady`). */
  create(request: CreateVm, o?: { signal?: AbortSignal }): Promise<VmInfo>
  /** The machine, or null once it's gone. */
  get(id: string, o?: { signal?: AbortSignal }): Promise<VmInfo | null>
  /** Lets `publicKey` (or, on a token provider, anyone with the token) log in for `minutes`. */
  sshAccess(id: string, r: { publicKey: string; minutes: number }): Promise<SshAccess>
  /** Sets how long it lives from now; the TTL the provider granted, when it says. */
  setTtl(id: string, seconds: number): Promise<{ ttlSeconds?: number }>
  /** Deletes it; one already gone counts as deleted. */
  remove(id: string, o?: { signal?: AbortSignal }): Promise<void>
  /** Every machine with `labels` and a name starting `namePrefix`, across pages. */
  list(
    filter: { namePrefix?: string; labels?: Record<string, string> },
    o?: { signal?: AbortSignal },
  ): AsyncIterable<VmInfo>
  limits?(o?: { signal?: AbortSignal }): Promise<VmLimits>
  exec?(
    id: string,
    command: string,
    o?: { timeoutSeconds?: number; cwd?: string },
  ): Promise<ExecResult>
  spawn?(id: string, command: string, o?: { cwd?: string }): Promise<{ processId: string }>
  status?(id: string, processId: string, o?: { tailBytes?: number }): Promise<ProcessStatus>
}
