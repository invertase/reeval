// What an attempt's sandbox gave it and what it used: one shell loop prints a reading a second
// (only `sleep` forks), and teardown takes one more before the sandbox goes. The loop runs where
// the agent can't reach it: beside a container in a sibling that reads its cgroup from outside,
// and on a VM as root.
import type { DockerSession, Spawned } from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import type { AttemptResources } from '../types.ts'

/** Milliseconds between readings. */
export const SAMPLE_MS = 1000
/** How long teardown's last reading may take. */
const FINAL_TIMEOUT_MS = 15_000
/** How long an attempt waits for its sampler to start. */
const START_TIMEOUT_MS = 15_000

/** What the script reads: a container's cgroup, a Linux VM's `/proc`, or a macOS VM's sizes alone. */
export type SampleMode = AttemptResources['scope'] | 'darwin'

/**
 * `$1` is the mode, `$2` the seconds between readings or `once`, `$3` the container whose cgroup
 * to find from the host's cgroup namespace, when the script runs outside it. First a line
 * `limits <cpu quota> <cpu period> <memory bytes> <cpus> <clock ticks>`, then a line
 * `s <uptime> <cpu> <memory bytes> <disk read bytes> <disk written bytes> <memory peak bytes>
 * <cpu periods> <throttled periods> <throttled usec>` per reading, `-` where there's nothing to
 * read. The uptime times each reading in the sandbox, so a late line on the host doesn't skew the
 * cores between two. A container's CPU is cgroup v2's `usage_usec`, its memory `memory.current`
 * less `inactive_file`, its memory peak `memory.peak` and its throttling `cpu.stat`'s
 * `nr_periods`, `nr_throttled` and `throttled_usec`; a VM's CPU is `/proc/stat`'s busy ticks
 * (steal is the hypervisor's, not the VM's), its memory `MemTotal` less `MemAvailable`, and its
 * disks every block device but loop, RAM, CD and stacked ones. A macOS VM has neither, so it
 * prints its `sysctl` sizes and stops. From outside, the container's cgroup is the directory
 * beside the script's own cgroup, or up to two levels up, named for its id, but not Podman's
 * `libpod-conmon-<id>.scope`, which holds the container's monitor under systemd. A container's
 * cgroup the script can't find, or that's
 * gone, ends it. Its stderr goes nowhere: nothing reads it, and a full pipe would stop the
 * readings.
 */
const SCRIPT = `exec 2>/dev/null
c=/sys/fs/cgroup
if [ "$1" = darwin ]; then
  echo "limits - - $(sysctl -n hw.memsize || echo -) $(sysctl -n hw.ncpu || echo -) -"
  exit 0
fi
if [ "$1" = container ]; then
  if [ -n "$3" ]; then
    own=
    while IFS= read -r l; do case $l in 0::*) own=\${l#0::} ;; esac; done < /proc/self/cgroup
    d=\${own%/*} t=
    for _ in 1 2 3; do
      for x in "$c$d"/*"$3"*; do
        case \${x##*/} in *conmon*) continue ;; esac
        [ -d "$x" ] && t=$x && break
      done
      [ -n "$t" ] || [ -z "$d" ] && break
      d=\${d%/*}
    done
    [ -n "$t" ] || exit 0
    c=$t
  fi
  [ -r $c/cpu.stat ] && [ -r $c/memory.current ] && [ -r $c/memory.stat ] || exit 0
  q=- p=- m=-
  [ -r $c/cpu.max ] && read -r q p < $c/cpu.max
  [ -r $c/memory.max ] && read -r m < $c/memory.max
  echo "limits $q $p $m $(nproc 2>/dev/null || echo -) -"
else
  [ -r /proc/stat ] && [ -r /proc/meminfo ] || exit 0
  while read -r k v _; do [ "$k" = MemTotal: ] && t=$v; done < /proc/meminfo
  echo "limits - - $((t * 1024)) $(nproc 2>/dev/null || echo -) $(getconf CLK_TCK 2>/dev/null || echo 100)"
fi
sample() {
  up=-
  [ -r /proc/uptime ] && read -r up _ < /proc/uptime
  if [ "$1" = container ]; then
    u=0 i=0 np=- nt=- tu=- pk=-
    read -r cur < $c/memory.current || exit 0
    while read -r k v; do
      case $k in usage_usec) u=$v ;; nr_periods) np=$v ;; nr_throttled) nt=$v ;; throttled_usec) tu=$v ;; esac
    done < $c/cpu.stat
    while read -r k v; do [ "$k" = inactive_file ] && i=$v; done < $c/memory.stat
    [ -r $c/memory.peak ] && read -r pk < $c/memory.peak
    echo "s $up $u $((cur - i)) - - $pk $np $nt $tu"
  else
    read -r _ us ni sy _ _ ir so _ < /proc/stat
    t=0 a=0
    while read -r k v _; do
      case $k in MemTotal:) t=$v ;; MemAvailable:) a=$v ;; esac
    done < /proc/meminfo
    r=0 w=0
    for d in /sys/block/*; do
      case \${d##*/} in loop*|ram*|zram*|sr*|dm-*|md*) continue ;; esac
      [ -r "$d/stat" ] && read -r _ _ rs _ _ _ ws _ < "$d/stat" && r=$((r + rs)) && w=$((w + ws))
    done
    echo "s $up $((us + ni + sy + ir + so)) $(((t - a) * 1024)) $((r * 512)) $((w * 512)) - - - -"
  fi
}
sample "$1"
[ "$2" = once ] && exit 0
while sleep "$2"; do sample "$1"; done`

const command = (mode: SampleMode, every: string, target?: string) =>
  `sh -c ${q(SCRIPT)} sh ${mode} ${every}${target ? ` ${q(target)}` : ''}`

export type Limits = {
  quota: number | null
  period: number | null
  memory: number | null
  cpus: number | null
  ticks: number | null
}
export type Reading = {
  /** The sandbox's uptime when it was read, in milliseconds, else `performance.now()` when the line arrived. */
  at: number
  cpu: number
  memory: number | null
  read: number | null
  written: number | null
  memoryPeak: number | null
  periods: number | null
  throttled: number | null
  throttledUsec: number | null
}

const num = (s: string | undefined) => {
  if (s === undefined || !/^\d+$/.test(s)) return null
  return Number(s)
}

/** A line the script printed, or null for anything else. */
export function parseLine(
  line: string,
  at: number,
): { limits: Limits } | { reading: Reading } | null {
  const [tag, ...f] = line.trim().split(/\s+/)
  if (tag === 'limits' && f.length === 5) {
    const [quota, period, memory, cpus, ticks] = f.map(num)
    return {
      limits: {
        quota: quota ?? null,
        period: period ?? null,
        memory: memory ?? null,
        cpus: cpus ?? null,
        ticks: ticks ?? null,
      },
    }
  }
  const cpu = num(f[1])
  if (tag !== 's' || f.length !== 9 || cpu === null) return null
  const up = f[0] !== undefined && /^\d+(\.\d+)?$/.test(f[0]) ? Number(f[0]) * 1000 : at
  return {
    reading: {
      at: up,
      cpu,
      memory: num(f[2]),
      read: num(f[3]),
      written: num(f[4]),
      memoryPeak: num(f[5]),
      periods: num(f[6]),
      throttled: num(f[7]),
      throttledUsec: num(f[8]),
    },
  }
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places

/** The nearest-rank `p` quantile of `values`, which it sorts. */
const quantile = (values: number[], p: number) =>
  values.sort((x, y) => x - y)[Math.max(0, Math.ceil(p * values.length) - 1)] as number

const delta = (first: number | null, last: number | null) =>
  first === null || last === null ? null : Math.max(0, last - first)

/**
 * The resources from the readings, in order: what the sandbox gave from `limits`, and what it used
 * between the first reading and the last. Without two readings there's no usage.
 */
export function summarize(
  scope: AttemptResources['scope'],
  machine: { sandbox: string; size?: string },
  limits: Limits | null,
  readings: readonly Reading[],
  o: { sampleMs: number; partial: boolean },
): AttemptResources {
  const quota = limits?.quota && limits.period ? round(limits.quota / limits.period, 2) : null
  const vcpus = quota ?? limits?.cpus ?? null
  const resources: AttemptResources = {
    scope,
    machine: {
      ...machine,
      ...(vcpus !== null && { vcpus }),
      ...(limits?.memory != null && { memoryBytes: limits.memory }),
    },
  }
  const first = readings[0]
  const last = readings.at(-1)
  const perSecond = scope === 'container' ? 1e6 : limits?.ticks
  if (!first || !last || first === last || !perSecond || last.at <= first.at) return resources
  const durationMs = last.at - first.at
  const cpuSeconds = Math.max(0, last.cpu - first.cpu) / perSecond
  const cores: number[] = []
  // A pair closer than half an interval (teardown's reading right after one) says little.
  for (let i = 1; i < readings.length; i++) {
    const [a, b] = [readings[i - 1] as Reading, readings[i] as Reading]
    if (b.at - a.at < o.sampleMs / 2) continue
    cores.push(Math.max(0, b.cpu - a.cpu) / perSecond / ((b.at - a.at) / 1000))
  }
  const memory = readings.flatMap((r) => (r.memory === null ? [] : [r.memory]))
  const memoryPeak = readings.flatMap((r) => (r.memoryPeak === null ? [] : [r.memoryPeak]))
  const disk =
    scope === 'machine' &&
    first.read !== null &&
    last.read !== null &&
    first.written !== null &&
    last.written !== null
  const periods = delta(first.periods, last.periods)
  const throttled = delta(first.throttled, last.throttled)
  const throttledUsec = delta(first.throttledUsec, last.throttledUsec)
  resources.usage = {
    durationMs: Math.round(durationMs),
    sampleMs: o.sampleMs,
    cpuSeconds: round(cpuSeconds),
    avgCores: round(cpuSeconds / (durationMs / 1000)),
    ...(cores.length && {
      peakCores: round(cores.reduce((x, y) => Math.max(x, y))),
      p95Cores: round(quantile(cores, 0.95)),
    }),
    ...(memory.length && { peakMemoryBytes: memory.reduce((x, y) => Math.max(x, y)) }),
    ...(memoryPeak.length && {
      cgroupPeakMemoryBytes: memoryPeak.reduce((x, y) => Math.max(x, y)),
    }),
    ...(periods !== null &&
      throttled !== null &&
      throttledUsec !== null && {
        throttling: {
          periods,
          throttledPeriods: throttled,
          throttledSeconds: round(throttledUsec / 1e6),
        },
      }),
    ...(disk && {
      diskReadBytes: Math.max(0, (last.read ?? 0) - (first.read ?? 0)),
      diskWriteBytes: Math.max(0, (last.written ?? 0) - (first.written ?? 0)),
    }),
    ...(o.partial && { partial: true as const }),
  }
  return resources
}

export type ResourceMeter = {
  /**
   * Resolves once the readings have begun, every host has ended without them, `signal` aborts or
   * {@link START_TIMEOUT_MS} has passed, so what the attempt does from then on is measured: an
   * observer's container can take seconds to start on a busy daemon. Never rejects.
   */
  ready(signal?: AbortSignal): Promise<void>
  /**
   * Takes the last reading, unless the sandbox is `gone`, ends the readings and returns the
   * resources. Never throws.
   */
  stop(o: { gone: boolean }): Promise<AttemptResources>
}

/** Somewhere the script can run: it starts the loop there and takes teardown's reading. */
export type SamplerHost = {
  spawn(o: { command: string }): Promise<Pick<Spawned, 'pid' | 'stdout' | 'kill'>>
  run(o: {
    command: string
    abortSignal?: AbortSignal
  }): Promise<{ exitCode: number; stdout: string }>
  /** The container whose cgroup the script finds, when it runs outside it. */
  target?: string
}

/**
 * Where a session's sampler runs, in order of preference: a container's observer, then root in
 * the sandbox, where a sandbox user without root can't signal it.
 */
export function samplerHosts(
  session: Pick<DockerSession, 'observer' | 'spawnPrivileged' | 'runPrivileged'>,
): SamplerHost[] {
  const privileged: SamplerHost = {
    spawn: (o) => session.spawnPrivileged(o),
    run: (o) => session.runPrivileged(o),
  }
  return session.observer ? [session.observer, privileged] : [privileged]
}

const killHost = (pid: number | undefined) => {
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

/**
 * Starts reading what a sandbox uses, on the first of `hosts` whose script prints its limits: one
 * that ends without them (no observer, no cgroup to find there) hands over to the next.
 */
export function startMeter(
  hosts: readonly SamplerHost[],
  mode: SampleMode,
  machine: { sandbox: string; size?: string },
  sampleMs = SAMPLE_MS,
): ResourceMeter {
  const scope: AttemptResources['scope'] = mode === 'container' ? 'container' : 'machine'
  let limits: Limits | null = null
  const readings: Reading[] = []
  let stopping = false
  let current: { host: SamplerHost; proc: Pick<Spawned, 'pid' | 'kill'> } | undefined
  let measuring: SamplerHost | undefined
  let begin = () => {}
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const take = (line: string, host: SamplerHost, at = performance.now()) => {
    const parsed = parseLine(line, at)
    if (!parsed) return
    if ('limits' in parsed) {
      limits ??= parsed.limits
      measuring ??= host
      begin()
    } else readings.push(parsed.reading)
  }
  const read = (async () => {
    for (const host of hosts) {
      if (stopping) return
      const proc = await Promise.resolve()
        .then(() => host.spawn({ command: command(mode, String(sampleMs / 1000), host.target) }))
        .catch(() => null)
      if (!proc) continue
      current = { host, proc }
      let rest = ''
      const decoder = new TextDecoder()
      try {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
          const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n')
          rest = lines.pop() ?? ''
          for (const line of lines) take(line, host)
        }
      } catch {}
      if (measuring || stopping) return
      await Promise.resolve(proc.kill()).catch(() => {})
    }
  })()
  const ready = async (signal?: AbortSignal) => {
    let end = () => {}
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    const timer = setTimeout(end, START_TIMEOUT_MS)
    signal?.addEventListener('abort', end, { once: true })
    if (signal?.aborted) end()
    await Promise.race([started, read, ended])
    clearTimeout(timer)
    signal?.removeEventListener('abort', end)
  }
  return {
    ready,
    async stop({ gone }) {
      // The last reading runs where the readings come from, so it waits for them to have begun.
      if (!gone) await ready()
      stopping = true
      let final = false
      const host = measuring ?? current?.host
      if (!gone && host) {
        const r = await Promise.resolve(
          host.run({
            command: command(mode, 'once', host.target),
            abortSignal: AbortSignal.timeout(FINAL_TIMEOUT_MS),
          }),
        ).catch(() => null)
        const at = performance.now()
        for (const line of r?.exitCode === 0 ? r.stdout.split('\n') : []) {
          const parsed = parseLine(line, at)
          if (parsed && 'reading' in parsed) {
            readings.push(parsed.reading)
            final = true
          } else if (parsed) limits ??= parsed.limits
        }
      }
      const proc = current?.proc
      // A gone sandbox took an in-sandbox loop with it, and its in-sandbox kill (over SSH, up to
      // 30 s) has nothing to reach: end only the host's client. The session removes an observer.
      if (gone) killHost(proc?.pid)
      else await Promise.resolve(proc?.kill()).catch(() => {})
      await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 1000))])
      readings.sort((x, y) => x.at - y.at)
      return summarize(scope, machine, limits, readings, { sampleMs, partial: !final })
    },
  }
}

/**
 * A meter for a machine other attempts run on at the same time: no readings, whose whole-VM
 * usage would count theirs too, only the machine's sizes from one reading at teardown.
 */
export function sharedMeter(
  hosts: readonly SamplerHost[],
  mode: SampleMode,
  machine: { sandbox: string; size?: string },
): ResourceMeter {
  return {
    ready: async () => {},
    async stop({ gone }) {
      let limits: Limits | null = null
      const host = hosts.at(-1)
      if (!gone && host) {
        const r = await Promise.resolve(
          host.run({
            command: command(mode, 'once', host.target),
            abortSignal: AbortSignal.timeout(FINAL_TIMEOUT_MS),
          }),
        ).catch(() => null)
        for (const line of r?.exitCode === 0 ? r.stdout.split('\n') : []) {
          const parsed = parseLine(line, performance.now())
          if (parsed && 'limits' in parsed) limits ??= parsed.limits
        }
      }
      const resources = summarize('machine', machine, limits, [], {
        sampleMs: SAMPLE_MS,
        partial: false,
      })
      return { ...resources, shared: true }
    },
  }
}
