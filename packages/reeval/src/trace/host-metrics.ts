// The machine `reeval run` runs on, sampled for OpenTelemetry's metrics with OpenTelemetry's
// semantic-convention names: its CPU, memory, load and the filesystems the run writes to, and this
// process's own CPU and memory. Containers on the machine share its kernel, so their use counts.
import { statfsSync, statSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import type { OtlpMetric } from './otlp.ts'

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
  readonly #startMs = Date.now()
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
  sample(): OtlpMetric[] {
    const timeMs = Date.now()
    const startMs = this.#startMs
    const gauge = (name: string, unit: string, description: string, value: number) => ({
      name,
      unit,
      description,
      type: 'gauge' as const,
      startMs,
      timeMs,
      points: [{ value }],
    })

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
    const metrics: OtlpMetric[] = [
      gauge(
        'system.cpu.utilization',
        '1',
        'CPU in use, over every core',
        total > 0 ? busy / total : 0,
      ),
      gauge(
        'system.cpu.load_average.1m',
        '{run_queue_item}',
        'Load average over 1 minute',
        loadavg()[0] ?? 0,
      ),
      {
        name: 'system.memory.usage',
        unit: 'By',
        description: 'Memory in use and free',
        type: 'updown',
        startMs,
        timeMs,
        points: [
          { value: memTotal - memFree, int: true, attributes: { 'system.memory.state': 'used' } },
          { value: memFree, int: true, attributes: { 'system.memory.state': 'free' } },
        ],
      },
      gauge(
        'system.memory.utilization',
        '1',
        'Memory in use',
        memTotal ? (memTotal - memFree) / memTotal : 0,
      ),
      gauge(
        'process.cpu.utilization',
        '1',
        "reeval's CPU, over every core",
        wallUs > 0 ? (proc.user + proc.system) / wallUs : 0,
      ),
      {
        name: 'process.memory.usage',
        unit: 'By',
        description: "reeval's resident memory",
        type: 'updown',
        startMs,
        timeMs,
        points: [{ value: process.memoryUsage.rss(), int: true }],
      },
    ]

    for (const path of this.#paths) {
      try {
        const fs = statfsSync(path)
        const used = (fs.blocks - fs.bfree) * fs.bsize
        const free = fs.bavail * fs.bsize
        const mount = { 'system.filesystem.mountpoint': path }
        metrics.push(
          {
            name: 'system.filesystem.usage',
            unit: 'By',
            description: 'Filesystem space used and free',
            type: 'updown',
            startMs,
            timeMs,
            points: [
              {
                value: used,
                int: true,
                attributes: { ...mount, 'system.filesystem.state': 'used' },
              },
              {
                value: free,
                int: true,
                attributes: { ...mount, 'system.filesystem.state': 'free' },
              },
            ],
          },
          {
            ...gauge('system.filesystem.utilization', '1', 'Filesystem space used', 0),
            points: [{ value: used + free ? used / (used + free) : 0, attributes: mount }],
          },
        )
      } catch {}
    }
    return metrics
  }
}
