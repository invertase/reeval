import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { EgressTraffic, NetworkPolicy, Substitution } from '@reeval/sandbox-docker'
import type { SecretWarning } from '../history/types.ts'
import type { ModelCall } from '../model-calls.ts'
import type { ExecResult } from '../types.ts'
import type { ResourceMeter } from './resources.ts'

export type ExecOptions = { signal?: AbortSignal; env?: Record<string, string>; cwd?: string }

export interface Sandbox {
  /** Absolute path of the agent's working directory inside the sandbox. */
  readonly workdir: string
  /** Absolute path of the home directory; `~/` paths in `writeFile` resolve here. */
  readonly home: string
  /**
   * Absolute path of a directory for reeval's own state (the diff's snapshot), outside the
   * workspace and home. In Docker without `root` the agent's user can't read it; a `root`
   * container's agent and the fake sandbox's host user can.
   */
  readonly stateDir: string
  /** `cwd` is relative to the workspace; `env` adds variables for this command only. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  /**
   * Runs one of reeval's own commands, able to read every file in the workspace and to write
   * {@link stateDir}. In Docker it runs in {@link stateDir}, not the workspace, so a command
   * names {@link workdir} itself. Without the eval's per-command variables or the gateway's.
   */
  execOwn(command: string, opts?: { signal?: AbortSignal }): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
  /** Strings are written as UTF-8; bytes as they are. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  /** With the Docker egress gateway: the brokered secrets it swaps in from now on. */
  setSubstitutions?(subs: readonly Substitution[]): Promise<void>
  /**
   * Starts the attempt's next phase (`setup`, then `agent`) under `policy`, which the sandbox
   * enforces from now on; `direct` keeps its own network for traffic that ignores the proxy.
   */
  setEgress?(o: { policy: NetworkPolicy; direct: boolean; phase: 'setup' | 'agent' }): Promise<void>
  /** When the sandbox records egress: the hosts contacted and refused so far. */
  traffic?(): EgressTraffic
  /**
   * When the harness's requests or their responses name the model: each model that served its
   * brokered requests so far, in first-seen order.
   */
  servedModels?(): string[]
  /** The same, one entry per brokered request that named its model, in order. */
  servedRequests?(): string[]
  /**
   * When the harness's successful requests say which model they asked for but nothing names the
   * one that served them: each model asked for so far, in first-seen order.
   */
  askedModels?(): string[]
  /**
   * When a gateway names the upstream provider behind each call (OpenRouter): each provider that
   * served the harness's brokered requests so far, with how many, in first-seen order.
   */
  upstreams?(): Array<{ provider: string; calls: number }>
  /** The same gateway's cost for those requests so far, in US dollars; undefined when it named none. */
  reportedCostUsd?(): number | undefined
  /** With credential brokering: the agent's model calls so far, in the order they ended. */
  modelCalls?(): ModelCall[]
  /** With credential brokering: the HTTP status of each brokered request so far, in order. */
  brokeredStatuses?(): number[]
  /** With brokered secrets: each one's placeholder sent where it isn't swapped in, so far. */
  secretWarnings?(): SecretWarning[]
  /**
   * When the sandbox has a memory limit: how many processes the kernel killed at it so far, and
   * the limit and the swap on top as the eval set them (`swap` is `null` without any). `null`
   * when it can't tell.
   */
  oomKills?(): Promise<{ kills: number; limit: string; swap: string | null } | null>
  /**
   * Starts reading what the sandbox gives the attempt and what it uses; unset where nothing
   * can be read, such as the fake sandbox on the host.
   */
  meter?(): ResourceMeter
  /** Idempotent, never throws. */
  destroy(): Promise<void>
  /**
   * Host URL for a container (or fake-host) port. Docker tunnels through the egress
   * gateway; the fake sandbox is `http://127.0.0.1:<port>`.
   */
  getPortEndpoint?(opts: { port: number; protocol?: 'http' | 'ws' }): Promise<{ url: string }>
}

/** A sandbox that also exposes its harness session, so a real harness drives the same machine. */
export type NetworkSandbox = Sandbox & { readonly network: HarnessV1NetworkSandboxSession }

export const hasNetworkSession = (s: Sandbox): s is NetworkSandbox => 'network' in s

/** A failure of the sandbox or harness infrastructure, as opposed to the agent's work. */
export class InfraError extends Error {
  override name = 'InfraError'
  /** Another try may succeed: a 5xx, a network error or a timeout, not a refused key or a bad config. */
  readonly transient: boolean
  constructor(message: string, options: { transient?: boolean } = {}) {
    super(message)
    this.transient = options.transient ?? false
  }
}

/**
 * The machine service ended the run: it starts no more machines for it, so an attempt waiting
 * for one stops as a canceled run's does, rather than failing.
 */
export class RunStopped extends Error {
  override name = 'RunStopped'
}

/**
 * The machine service took a reused machine back at the boundary before its next attempt (the run
 * holds more machines than it may now), so the attempt gets another, and nothing failed.
 */
export class MachineReclaimed extends Error {
  override name = 'MachineReclaimed'
}
