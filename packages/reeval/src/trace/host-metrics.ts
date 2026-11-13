// The machine `reeval run` runs on, sampled for OpenTelemetry's metrics with OpenTelemetry's
// semantic-convention names: its CPU, memory, load and the filesystems the run writes to, and this
// process's own CPU and memory. Containers on the machine share its kernel, so their use counts.
import { statfsSync, statSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem } from 'node:os'

/** Each metric: a gauge, or an up-down counter of bytes. */
export const HOST_METRICS = {
  'system.cpu.utilization': { unit: '1', description: 'CPU in use, over every core', bytes: false },
  'system.cpu.load_average.1m': {
    unit: '{run_queue_item}',
    description: 'Load average over 1 minute',
    bytes: false,
  },
  'system.memory.usage': { unit: 'By', description: 'Memory in use and free', bytes: true },
  'system.memory.utilization': { unit: '1', description: 'Memory in use', bytes: false },
  'process.cpu.utilization': {
    unit: '1',
    description: "reeval's CPU, over every core",
    bytes: false,
  },
  'process.memory.usage': { unit: 'By', description: "reeval's resident memory", bytes: true },
  'system.filesystem.usage': {
    unit: 'By',
    description: 'Filesystem space used and free',
    bytes: true,
  },
  'system.filesystem.utilization': {
    unit: '1',
    description: 'Filesystem space used',
    bytes: false,
  },
} as const

export type HostMetric = keyof typeof HOST_METRICS

export type HostPoint = { name: HostMetric; value: number; attributes?: Record<string, string> }

const cpuTimes = () => {
  let busy = 0
  let total = 0
  for (const { times } of cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq
    busy += all - times.idle
    total += all
  }
  return { busy, total }
}

export class HostMetrics {
  readonly #paths: string[]
  #cpu = cpuTimes()
  #proc = process.cpuUsage()
  #at = performance.now()

  /** `paths` name the filesystems to report, one per device. */
  constructor(paths: string[]) {
    const seen = new Set<number>()
    this.#paths = paths.filter((p) => {
      try {
        const { dev } = statSync(p)
        if (seen.has(dev)) return false
        seen.add(dev)
        return true
      } catch {
        return false
      }
    })
  }

  /** The metrics now, the CPU's over the time since the last sample. */
  sample(): HostPoint[] {
    const cpu = cpuTimes()
    const busy = cpu.busy - this.#cpu.busy
    const total = cpu.total - this.#cpu.total
    this.#cpu = cpu
    const now = performance.now()
    const proc = process.cpuUsage(this.#proc)
    this.#proc = process.cpuUsage()
    const wallUs = (now - this.#at) * 1000 * Math.max(1, cpus().length)
    this.#at = now

    const memTotal = totalmem()
    const memFree = freemem()
    const points: HostPoint[] = [
      { name: 'system.cpu.utilization', value: total > 0 ? busy / total : 0 },
      { name: 'system.cpu.load_average.1m', value: loadavg()[0] ?? 0 },
      {
        name: 'system.memory.usage',
        value: memTotal - memFree,
        attributes: { 'system.memory.state': 'used' },
      },
      {
        name: 'system.memory.usage',
        value: memFree,
        attributes: { 'system.memory.state': 'free' },
      },
      {
        name: 'system.memory.utilization',
        value: memTotal ? (memTotal - memFree) / memTotal : 0,
      },
      {
        name: 'process.cpu.utilization',
        value: wallUs > 0 ? (proc.user + proc.system) / wallUs : 0,
      },
      { name: 'process.memory.usage', value: process.memoryUsage.rss() },
    ]

    for (const path of this.#paths) {
      try {
        const fs = statfsSync(path)
        const used = (fs.blocks - fs.bfree) * fs.bsize
        const free = fs.bavail * fs.bsize
        const mount = { 'system.filesystem.mountpoint': path }
        points.push(
          {
            name: 'system.filesystem.usage',
            value: used,
            attributes: { ...mount, 'system.filesystem.state': 'used' },
          },
          {
            name: 'system.filesystem.usage',
            value: free,
            attributes: { ...mount, 'system.filesystem.state': 'free' },
          },
          {
            name: 'system.filesystem.utilization',
            value: used + free ? used / (used + free) : 0,
            attributes: mount,
          },
        )
      } catch {}
    }
    return points
  }
}
