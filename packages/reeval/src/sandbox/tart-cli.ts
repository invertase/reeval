// The `tart` CLI, as the Tart sandbox's provider and sessions call it: on this machine, or on a
// host of `tart({ hosts })` over SSH.
import { traceDocker } from '@reeval/sandbox-docker'
import { type RunResult, run } from '@reeval/sandbox-docker/process'

/** Where `tart` runs: this machine, or a Mac reached over SSH (tart-hosts.ts). */
export type TartTarget = {
  /** How messages name it: `this machine`, or the host as `tart({ hosts })` gave it. */
  label: string
  remote: boolean
  /** The host argv, program first, that runs `tart <args>` there. */
  tart(args: readonly string[]): string[]
  /** The host argv that runs `script` with `/bin/sh` there, `args` as its `$1`…, Homebrew on PATH. */
  sh(script: string, args?: readonly string[]): string[]
  /** The `ssh` `ProxyCommand` that reaches an address on a remote host, such as its VMs'. */
  proxy?: string
}

export const LOCAL_TART: TartTarget = {
  label: 'this machine',
  remote: false,
  tart: (args) => ['tart', ...args],
  sh: (script, args = []) => ['/bin/sh', '-c', script, 'sh', ...args],
}

export type TartOptions = {
  signal?: AbortSignal
  input?: string | Uint8Array
  /** Where `tart` runs; this machine when unset. */
  on?: TartTarget
}

/** Runs `bin` (`tart`, or `ssh` into a VM), into the attempt's trace as a docker command is. */
export async function tracedRun(
  bin: string,
  args: string[],
  options: TartOptions = {},
): Promise<RunResult> {
  const started = Date.now()
  try {
    const r = await run(bin, args, { signal: options.signal, input: options.input })
    traceDocker(args, started, { ...r, stdin: options.input?.length }, bin)
    return r
  } catch (error) {
    traceDocker(args, started, { error }, bin)
    throw error
  }
}

/** {@link tracedRun}, with stdout as bytes. */
export async function tracedRunBytes(
  bin: string,
  args: string[],
  options: TartOptions = {},
): Promise<RunResult<Buffer>> {
  const started = Date.now()
  try {
    const r = await run(bin, args, { signal: options.signal, input: options.input, binary: true })
    traceDocker(args, started, { ...r, stdin: options.input?.length }, bin)
    return r
  } catch (error) {
    traceDocker(args, started, { error }, bin)
    throw error
  }
}

/** Runs an argv a {@link TartTarget} made. */
export const runArgv = (argv: readonly string[], options: TartOptions = {}) => {
  const [bin = '', ...args] = argv
  return tracedRun(bin, args, options)
}

/** Runs `tart <args>`; rejects only when `tart` (or `ssh`) can't be started. */
export const tartCli = (args: string[], options: TartOptions = {}): Promise<RunResult> =>
  runArgv((options.on ?? LOCAL_TART).tart(args), options)

/** `tart <args>`'s stdout; throws its stderr when it fails. */
export async function tartOk(args: string[], options: TartOptions = {}): Promise<string> {
  const r = await tartCli(args, options)
  if (r.exitCode !== 0) {
    const where = options.on?.remote ? ` on ${options.on.label}` : ''
    throw new Error(`tart ${args[0]} failed${where}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  }
  return r.stdout
}

/** The VMs and images `tart list` knows, by name: local VMs, and OCI images pulled before. */
export async function tartNames(signal?: AbortSignal, on?: TartTarget): Promise<Set<string>> {
  return new Set((await tartVms(signal, on)).map((vm) => vm.name))
}

/** What `tart list` shows: each VM or image by name, whether it's running, and where from. */
export async function tartVms(
  signal?: AbortSignal,
  on?: TartTarget,
): Promise<Array<{ name: string; running: boolean; local: boolean }>> {
  const listed = JSON.parse(
    await tartOk(['list', '--format', 'json'], { signal, ...(on && { on }) }),
  ) as Array<{ Name?: string; State?: string; Source?: string }>
  return listed.flatMap((vm) =>
    vm.Name ? [{ name: vm.Name, running: vm.State === 'running', local: vm.Source !== 'OCI' }] : [],
  )
}
