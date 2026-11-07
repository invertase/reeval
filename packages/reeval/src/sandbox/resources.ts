// What an attempt's sandbox gave it and what it used: one shell loop in the sandbox prints a
// reading a second (only `sleep` forks), and teardown takes one more before the sandbox goes.
import type { DockerSession } from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import type { AttemptResources } from '../types.ts'

/** Milliseconds between readings. */
export const SAMPLE_MS = 1000
/** How long teardown's last reading may take. */
const FINAL_TIMEOUT_MS = 15_000

/**
 * `$1` is the scope, `$2` the seconds between readings or `once`. First a line
 * `limits <cpu quota> <cpu period> <memory bytes> <cpus> <clock ticks>`, then a line
 * `s <uptime> <cpu> <memory bytes> <disk read bytes> <disk written bytes>` per reading, `-` where
 * there's nothing to read. The uptime times each reading in the sandbox, so a late line on the host
 * doesn't skew the cores between two. A container's CPU is cgroup v2's `usage_usec` and its memory
 * `memory.current` less `inactive_file`; a VM's CPU is `/proc/stat`'s busy ticks (steal is the
 * hypervisor's, not the VM's), its memory `MemTotal` less `MemAvailable`, and its disks every block
 * device but loop, RAM, CD and stacked ones. Its stderr goes nowhere: nothing reads it, and a full
 * pipe would stop the readings.
 */
const SCRIPT = `exec 2>/dev/null
c=/sys/fs/cgroup
if [ "$1" = container ]; then
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
    u=0 i=0
    while read -r k v; do [ "$k" = usage_usec ] && u=$v; done < $c/cpu.stat
    read -r cur < $c/memory.current
    while read -r k v; do [ "$k" = inactive_file ] && i=$v; done < $c/memory.stat
    echo "s $up $u $((cur - i)) - -"
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
    echo "s $up $((us + ni + sy + ir + so)) $(((t - a) * 1024)) $((r * 512)) $((w * 512))"
  fi
}
sample "$1"
[ "$2" = once ] && exit 0
while sleep "$2"; do sample "$1"; done`

const command = (scope: AttemptResources['scope'], every: string) =>
  `sh -c ${q(SCRIPT)} sh ${scope} ${every}`

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
  if (tag !== 's' || f.length !== 5 || cpu === null) return null
  const up = f[0] !== undefined && /^\d+(\.\d+)?$/.test(f[0]) ? Number(f[0]) * 1000 : at
  return { reading: { at: up, cpu, memory: num(f[2]), read: num(f[3]), written: num(f[4]) } }
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places

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
  let peakCores: number | undefined
  // A pair closer than half an interval (teardown's reading right after one) says little.
  for (let i = 1; i < readings.length; i++) {
    const [a, b] = [readings[i - 1] as Reading, readings[i] as Reading]
    if (b.at - a.at < o.sampleMs / 2) continue
    const cores = Math.max(0, b.cpu - a.cpu) / perSecond / ((b.at - a.at) / 1000)
    peakCores = Math.max(peakCores ?? 0, cores)
  }
  const memory = readings.flatMap((r) => (r.memory === null ? [] : [r.memory]))
  const disk =
    scope === 'machine' &&
    first.read !== null &&
    last.read !== null &&
    first.written !== null &&
    last.written !== null
  resources.usage = {
    durationMs: Math.round(durationMs),
    sampleMs: o.sampleMs,
    cpuSeconds: round(cpuSeconds),
    avgCores: round(cpuSeconds / (durationMs / 1000)),
    ...(peakCores !== undefined && { peakCores: round(peakCores) }),
    ...(memory.length && { peakMemoryBytes: memory.reduce((x, y) => Math.max(x, y)) }),
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
   * Takes the last reading, unless the sandbox is `gone`, ends the readings and returns the
   * resources. Never throws.
   */
  stop(o: { gone: boolean }): Promise<AttemptResources>
}

/** Starts reading what `session`'s sandbox uses. */
export function startMeter(
  session: Pick<DockerSession, 'spawn' | 'run'>,
  scope: AttemptResources['scope'],
  machine: { sandbox: string; size?: string },
  sampleMs = SAMPLE_MS,
): ResourceMeter {
  let limits: Limits | null = null
  const readings: Reading[] = []
  const take = (line: string, at = performance.now()) => {
    const parsed = parseLine(line, at)
    if (!parsed) return
    if ('limits' in parsed) limits ??= parsed.limits
    else readings.push(parsed.reading)
  }
  const sampler = Promise.resolve()
    .then(() => session.spawn({ command: command(scope, String(sampleMs / 1000)) }))
    .catch(() => null)
  const read = sampler.then(async (proc) => {
    if (!proc) return
    let rest = ''
    const decoder = new TextDecoder()
    try {
      for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) take(line)
      }
    } catch {}
  })
  return {
    async stop({ gone }) {
      let final = false
      if (!gone) {
        const r = await Promise.resolve(
          session.run({
            command: command(scope, 'once'),
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
      const proc = await sampler
      await Promise.resolve(proc?.kill()).catch(() => {})
      await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 1000))])
      readings.sort((x, y) => x.at - y.at)
      return summarize(scope, machine, limits, readings, { sampleMs, partial: !final })
    },
  }
}
