// The `tart` CLI, as the Tart sandbox's provider and sessions call it.
import { traceDocker } from '@reeval/sandbox-docker'
import { type RunResult, run } from '@reeval/sandbox-docker/process'

export type TartOptions = { signal?: AbortSignal; input?: string | Uint8Array }

/** Runs `bin` (`tart`, or `ssh` into a VM), into the attempt's trace as a docker command is. */
export async function tracedRun(
  bin: string,
  args: string[],
  options: TartOptions = {},
): Promise<RunResult> {
  const started = Date.now()
  try {
    const r = await run(bin, args, options)
    traceDocker(args, started, { ...r, stdin: options.input?.length }, bin)
    return r
  } catch (error) {
    traceDocker(args, started, { error }, bin)
    throw error
  }
}

/** Runs `tart <args>`; rejects only when `tart` can't be started. */
export const tartCli = (args: string[], options: TartOptions = {}): Promise<RunResult> =>
  tracedRun('tart', args, options)

/** `tart <args>`'s stdout; throws its stderr when it fails. */
export async function tartOk(args: string[], options: TartOptions = {}): Promise<string> {
  const r = await tartCli(args, options)
  if (r.exitCode !== 0) {
    throw new Error(`tart ${args[0]} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  }
  return r.stdout
}

/** The VMs and images `tart list` knows, by name: local VMs, and OCI images pulled before. */
export async function tartNames(signal?: AbortSignal): Promise<Set<string>> {
  const listed = JSON.parse(await tartOk(['list', '--format', 'json'], { signal })) as Array<{
    Name?: string
  }>
  return new Set(listed.flatMap((vm) => (vm.Name ? [vm.Name] : [])))
}
