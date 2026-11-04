// The Macs of `tart({ hosts })`: how reeval reaches each over SSH, what preflight checks on each,
// and which one an attempt's VM starts on. Every `tart` command runs there over plain `ssh`; the
// egress gateway stays on this machine and reaches the VM through the same SSH connection.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { controlOptions, privateDir, SSH_OPTIONS } from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { type ParsedTartHost, parseTartHost, TART_MAX_CONCURRENT } from '../contract/tart.ts'
import type { TartSandboxDescriptor } from '../types.ts'
import { runArgv, type TartTarget, tartVms } from './tart-cli.ts'
import { InfraError } from './types.ts'

/** Ahead of a host's own PATH: a non-interactive SSH shell on macOS doesn't have Homebrew's. */
const HOST_PATH = '/opt/homebrew/bin:/usr/local/bin'
/** `ssh`'s own exit status when it can't connect, or the connection drops. */
const SSH_FAILED = 255
/** The probe script's exit status when the host has no `tart`. */
const NO_TART = 90
/** Free space below which preflight skips a host: a clone's disk grows as the attempt writes. */
export const HOST_MIN_FREE_BYTES = 25e9
/** Memory a host keeps for macOS and Tart, beside its VMs. */
export const HOST_RESERVED_MEMORY = 4 * 1024 ** 3
/** What preflight takes a VM to use when `tart({ memory })` is unset: Cirrus Labs' images' 8 GB. */
const DEFAULT_VM_MEMORY = 8 * 1024 ** 3
/** How long a host whose `tart run` said it's at its VM limit is passed over. */
export const BUSY_COOLDOWN_MS = 30_000
/** How long an attempt waits for a host with room before it fails as an infra error. */
export const BUSY_WAIT_MS = 20 * 60_000
const BUSY_POLL_MS = 5_000
/** How long counting one host's VMs may take before that host is passed over for a while. */
const BUSY_WAIT_POLL_TIMEOUT_MS = 60_000

/** `tart run`'s refusal when the Mac already runs as many macOS VMs as it may. */
export const AT_VM_LIMIT = /exceeds the system limit/i

/** `tart run` refused a VM because its host is at its VM limit: try another host, or wait. */
export class TartBusyError extends InfraError {
  override name = 'TartBusyError'
}

/**
 * One connection per host, shared by every command reeval runs there, for a minute after the last.
 * Its socket is under ~/.ssh, since macOS caps a socket's path at 104 bytes.
 */
const hostControl = () => {
  const dir = join(homedir(), '.ssh', 'reeval')
  if (process.platform !== 'win32') privateDir(dir, { make: true })
  return controlOptions(join(dir, '%C'), 60)
}

/** `~/…` on this machine, which `ssh -i` would also expand, made absolute for messages and traces. */
const expandHome = (path: string) => (path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path)

/** The `ssh` argv that reaches `host`, up to its destination: the user's own config applies. */
export function hostSsh(host: ParsedTartHost): string[] {
  return [
    'ssh',
    '-T',
    ...SSH_OPTIONS,
    '-o',
    'ConnectTimeout=15',
    ...hostControl(),
    ...(host.port !== undefined ? ['-p', String(host.port)] : []),
    ...(host.identityFile ? ['-i', expandHome(host.identityFile), '-o', 'IdentitiesOnly=yes'] : []),
    ...(host.user !== undefined ? ['-l', host.user] : []),
    '--',
    host.host,
  ]
}

/** Where `tart` runs for `host`: over `ssh`, each argument quoted for the login shell. */
export function hostTarget(host: ParsedTartHost): TartTarget {
  const ssh = hostSsh(host)
  const sh = (script: string, args: readonly string[] = []) => [
    ...ssh,
    ['/bin/sh', '-c', `PATH=${HOST_PATH}:"$PATH"; export PATH; ${script}`, 'sh', ...args]
      .map(q)
      .join(' '),
  ]
  return {
    label: host.label,
    remote: true,
    sh,
    tart: (args) => sh('exec tart "$@"', args),
    // ssh expands %-tokens in a ProxyCommand and knows only %h, %n, %p and %r there: the inner
    // ssh's own (ControlPath's %C) are escaped so it, not the outer one, expands them.
    proxy: [...ssh.slice(0, -2).map((a) => a.replaceAll('%', '%%')), '-W', '%h:%p', '--', host.host]
      .map(q)
      .join(' '),
  }
}

/** What preflight found on a host: room for `vms` of the run's VMs, or why it's skipped. */
export type HostProbe =
  | { ok: true; host: ParsedTartHost; vms: number; note?: string }
  | { ok: false; host: ParsedTartHost; skip: string }

/** Why a host can't be used at all: preflight stops the run, naming it. */
export class HostRefusal extends Error {
  override name = 'HostRefusal'
}

const PROBE = `tart --version || exit ${NO_TART}
d="\${TART_HOME:-$HOME/.tart}"; while [ ! -d "$d" ]; do d=$(dirname "$d"); done
df -Pk "$d" | awk 'NR == 2 { print "free", $4 * 1024 }'
echo "dir $d"
echo "memory $(sysctl -n hw.memsize)"
echo "system $(uname -s)-$(uname -m)"`

const sshCommand = (h: ParsedTartHost) =>
  `ssh ${h.port !== undefined ? `-p ${h.port} ` : ''}${h.user !== undefined ? `${h.user}@` : ''}${h.host} true`

const GB = (bytes: number) => `${Math.round(bytes / 1e9)} GB`
/** Memory as macOS and Tart's images size it: 8 GB is 8 GiB. */
const memoryGB = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GB`

/**
 * One SSH call per host, before anything is prepared: it answers, has `tart`, and is a Mac with
 * room on Tart's volume and memory for at least one VM. Throws a {@link HostRefusal} for a host
 * that can't be used at all; a full or small one comes back skipped.
 */
export async function probeHost(
  host: ParsedTartHost,
  sandbox: Pick<TartSandboxDescriptor, 'memory'>,
  signal?: AbortSignal,
): Promise<HostProbe> {
  const target = hostTarget(host)
  const r = await runArgv(target.sh(PROBE), { ...(signal && { signal }) })
  const said = r.stderr.trim().split('\n').slice(-3).join(' ')
  if (r.exitCode === SSH_FAILED) {
    throw new HostRefusal(
      `tart() host ${host.label} doesn't answer over SSH: ${said || 'ssh exited 255'}. reeval runs plain ssh with no prompt (BatchMode): check that ${sshCommand(host)} works from this machine with an ~/.ssh/config alias, the SSH agent or identityFile; passwords aren't supported.`,
    )
  }
  if (r.exitCode === NO_TART) {
    throw new HostRefusal(
      `tart() host ${host.label} has no tart command on its PATH (${HOST_PATH} and its own). Install it there (brew install cirruslabs/cli/tart) and try again.`,
    )
  }
  const facts = new Map(
    r.stdout
      .split('\n')
      .map((l) => /^(free|dir|memory|system) (.*)$/.exec(l.trim()))
      .flatMap((m) => (m ? [[m[1] as string, (m[2] as string).trim()] as const] : [])),
  )
  const system = facts.get('system') ?? ''
  if (r.exitCode !== 0 || !system) {
    throw new HostRefusal(
      `tart() host ${host.label} answered, but checking it failed: ${said || `exit ${r.exitCode}`}`,
    )
  }
  if (system !== 'Darwin-arm64') {
    throw new HostRefusal(
      `tart() host ${host.label} is ${system}: Tart runs macOS VMs on a Mac with Apple Silicon (Darwin-arm64).`,
    )
  }
  const free = Number(facts.get('free'))
  if (Number.isFinite(free) && free < HOST_MIN_FREE_BYTES) {
    return {
      ok: false,
      host,
      skip: `tart() host ${host.label} skipped: ${GB(free)} free in ${facts.get('dir')}, and reeval wants ${GB(HOST_MIN_FREE_BYTES)} for its VMs' disks. Free some space there, or set TART_HOME on it to a bigger volume.`,
    }
  }
  const memory = Number(facts.get('memory'))
  const each = sandbox.memory !== undefined ? memoryBytes(sandbox.memory) : DEFAULT_VM_MEMORY
  const fits = Number.isFinite(memory)
    ? Math.floor((memory - HOST_RESERVED_MEMORY) / each)
    : host.vms
  if (fits < 1) {
    return {
      ok: false,
      host,
      skip: `tart() host ${host.label} skipped: it has ${memoryGB(memory)} of memory, and one VM of ${memoryGB(each)} needs ${memoryGB(each + HOST_RESERVED_MEMORY)} with what macOS keeps. Give the VMs less with tart({ memory }), or drop the host.`,
    }
  }
  if (fits < host.vms) {
    return {
      ok: true,
      host,
      vms: fits,
      note: `tart() host ${host.label} runs ${fits} VM at a time, not ${host.vms}: it has ${memoryGB(memory)} of memory, and each VM takes ${memoryGB(each)}.`,
    }
  }
  return { ok: true, host, vms: host.vms }
}

const UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const
const memoryBytes = (memory: string | number) => {
  if (typeof memory === 'number') return memory
  const m = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(memory.trim())
  return Number(m?.[1] ?? 0) * UNITS[(m?.[2]?.toLowerCase() ?? 'b') as keyof typeof UNITS]
}

/** A host an attempt may start its VM on: where, how many at once, and the image it clones there. */
export type HostSlot = { target: TartTarget; vms: number; image: string }

/** What preflight prepared on one host, as an attempt reads it from the prepared handle. */
export type PreparedHost = { host: string; vms: number; image: string }

/**
 * The hosts an attempt of `sandbox` may use: the ones preflight kept, each with the image it
 * baked there, or every host of `sandbox` with `image` when preflight didn't say.
 */
export function hostSlots(
  sandbox: TartSandboxDescriptor,
  prepared: readonly PreparedHost[] | undefined,
  image: string,
): HostSlot[] {
  const parsed = (sandbox.hosts ?? []).flatMap((h) => {
    const p = parseTartHost(h)
    return typeof p === 'string' ? [] : [p]
  })
  if (!prepared) return parsed.map((h) => ({ target: hostTarget(h), vms: h.vms, image }))
  return prepared.flatMap((p) => {
    const host = parsed.find((h) => h.label === p.host)
    return host ? [{ target: hostTarget(host), vms: p.vms, image: p.image }] : []
  })
}

/** A VM on a host, as {@link hostLoad} counts it. */
export type HostVm = { name: string; running: boolean; os: string; own: boolean }

/**
 * How many more of the run's VMs `vms` lets a host start: its own `vms` less reeval's macOS VMs
 * there (running, or cloned and about to boot), and what macOS's limit leaves once every running
 * macOS VM is counted. Linux VMs count towards neither.
 */
export function freeSlots(vms: number, listed: readonly HostVm[]): number {
  const mac = listed.filter((vm) => vm.os !== 'linux')
  const own = mac.filter((vm) => vm.own).length
  const others = mac.filter((vm) => !vm.own && vm.running).length
  return Math.max(0, Math.min(vms - own, TART_MAX_CONCURRENT - own - others))
}

const OS_OF = `for n in "$@"; do printf '%s\\t' "$n"; tart get "$n" --format json 2>/dev/null | tr -d '\\n'; echo; done`

/**
 * This run's VMs on `target` (names starting `prefix`) and the others running there, each with
 * its OS: `tart list`, then `tart get`. A stopped VM of another run, such as one a killed reeval
 * left, holds no slot.
 */
export async function hostLoad(
  target: TartTarget,
  prefix: string,
  signal?: AbortSignal,
): Promise<HostVm[]> {
  const vms = (await tartVms(signal, target)).filter((vm) => vm.local)
  const counted = vms.flatMap((vm) => {
    const own = vm.name.startsWith(prefix)
    return own || vm.running ? [{ name: vm.name, running: vm.running, own }] : []
  })
  if (!counted.length) return []
  const r = await runArgv(
    target.sh(
      OS_OF,
      counted.map((vm) => vm.name),
    ),
    { ...(signal && { signal }) },
  )
  const os = new Map(
    r.stdout.split('\n').flatMap((line) => {
      const [name, json] = line.split('\t')
      if (!name) return []
      try {
        return [[name, String((JSON.parse(json ?? '') as { OS?: string }).OS ?? 'darwin')]]
      } catch {
        return [[name, 'darwin']]
      }
    }),
  )
  return counted.map((vm) => ({ ...vm, os: os.get(vm.name) ?? 'darwin' }))
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

/**
 * The host with the most room for one more VM, a random one of those tied, so attempts that
 * start together spread out. Hosts in `busy` until a time still to come are passed over. With
 * none free it waits while this run's own VMs hold the slots, since they end; once none does, it
 * waits until `deadline.at` ({@link BUSY_WAIT_MS} from the first claim), shared by every claim of
 * one attempt, and then fails: what holds the slots is outside the run.
 */
export async function claimHost(
  slots: readonly HostSlot[],
  o: {
    signal: AbortSignal
    busy: Map<string, number>
    /** The names of this run's VMs start with it. */
    prefix: string
    deadline?: { at: number }
    log?: (line: string) => void
    now?: () => number
  },
): Promise<HostSlot> {
  const now = o.now ?? Date.now
  const deadline = o.deadline ?? { at: now() + BUSY_WAIT_MS }
  const unreachable = new Set<string>()
  for (;;) {
    const open = slots.filter((s) => (o.busy.get(s.target.label) ?? 0) <= now())
    const free = await Promise.all(
      open.map(async (slot) => {
        try {
          const poll = AbortSignal.any([o.signal, AbortSignal.timeout(BUSY_WAIT_POLL_TIMEOUT_MS)])
          const load = await hostLoad(slot.target, o.prefix, poll)
          unreachable.delete(slot.target.label)
          return { slot, free: freeSlots(slot.vms, load), ours: load.some((vm) => vm.own) }
        } catch (error) {
          if (o.signal.aborted) throw error
          o.log?.(`couldn't count the VMs on ${slot.target.label}: ${(error as Error).message}`)
          unreachable.add(slot.target.label)
          o.busy.set(slot.target.label, now() + BUSY_COOLDOWN_MS)
          return { slot, free: 0, ours: false }
        }
      }),
    )
    const most = Math.max(0, ...free.map((f) => f.free))
    const best = free.filter((f) => f.free === most && most > 0)
    const pick = best[Math.floor(Math.random() * best.length)]
    if (pick) return pick.slot
    if (free.some((f) => f.ours)) deadline.at = Math.max(deadline.at, now() + BUSY_WAIT_MS)
    if (now() > deadline.at) {
      const why = unreachable.size ? ` (${[...unreachable].join(', ')} didn't answer)` : ''
      throw new InfraError(
        `Every tart() host was at its VM limit for ${BUSY_WAIT_MS / 60_000} minutes${why}: ${slots.map((s) => s.target.label).join(', ')}. VMs outside this run hold their slots; stop them (tart stop <name>), or add a host.`,
      )
    }
    o.log?.(`every host is at its VM limit: waiting for one`)
    await sleep(BUSY_POLL_MS, o.signal)
  }
}

/** Another attempt took the host's last slot between counting its VMs and cloning: pick again. */
export class HostTaken extends InfraError {
  override name = 'HostTaken'
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, expanded on the host
const CLAIM_LOCK = '"${TART_HOME:-$HOME/.tart}/reeval-claim.lock"'
/** Takes the lock, or exits 75 while another claim holds it; one held over a minute is broken. */
const LOCK = `l=${CLAIM_LOCK}; mkdir -p "\${l%/*}"
mkdir "$l" 2>/dev/null && exit 0
[ -n "$(find "$l" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$l" 2>/dev/null && mkdir "$l" 2>/dev/null && exit 0
exit 75`
const UNLOCK = `rmdir ${CLAIM_LOCK} 2>/dev/null; true`
const LOCK_POLL_MS = 250

/**
 * Runs `step` holding `target`'s claim lock, a directory on the Mac itself, so that two attempts
 * (in any worker, or any reeval reaching that Mac) can't both count a free slot and clone into it.
 * The lock is held only from counting to cloning: once cloned, a VM counts as taken.
 */
export async function withHostClaim<T>(
  target: TartTarget,
  signal: AbortSignal,
  step: () => Promise<T>,
): Promise<T> {
  for (;;) {
    const r = await runArgv(target.sh(LOCK), { signal })
    if (r.exitCode === 0) break
    if (r.exitCode !== 75) {
      throw new InfraError(
        `Couldn't lock ${target.label} to start a VM there: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
      )
    }
    await sleep(LOCK_POLL_MS, signal)
  }
  try {
    return await step()
  } finally {
    await runArgv(target.sh(UNLOCK)).catch(() => {})
  }
}
