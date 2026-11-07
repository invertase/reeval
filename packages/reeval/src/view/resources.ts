import type { AttemptResources } from '../types.ts'

/** Bytes in binary units, as container limits are given: `512 MiB`, `3.8 GiB`. */
export function formatMemory(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KiB`
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MiB`
  return `${(n / 1024 ** 3).toFixed(1)} GiB`
}

const cores = (n: number) => n.toFixed(2)

/** What the attempt ran on: `docker 2 vCPU 4.0 GiB`, `boat small 2 vCPU 3.8 GiB`. */
export function machineLabel(machine: AttemptResources['machine']): string {
  return [
    machine.sandbox,
    machine.size,
    machine.vcpus !== undefined ? `${machine.vcpus} vCPU` : undefined,
    machine.memoryBytes !== undefined ? formatMemory(machine.memoryBytes) : undefined,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * A run's attempts' resources, one part per machine: how many attempts measured, their CPU time
 * added up, their average cores over the time they ran, and the highest peak cores and memory of
 * any one. Null when no attempt has readings.
 */
export function runResourcesLine(all: ReadonlyArray<AttemptResources | undefined>): string | null {
  const byMachine = new Map<string, AttemptResources[]>()
  for (const r of all) {
    if (!r?.usage) continue
    const label = machineLabel(r.machine)
    byMachine.set(label, [...(byMachine.get(label) ?? []), r])
  }
  if (!byMachine.size) return null
  return [...byMachine]
    .map(([label, rs]) => {
      const usage = rs.flatMap((r) => (r.usage ? [r.usage] : []))
      const cpu = usage.reduce((sum, u) => sum + u.cpuSeconds, 0)
      const ms = usage.reduce((sum, u) => sum + u.durationMs, 0)
      const peaks = usage.flatMap((u) => (u.peakCores === undefined ? [] : [u.peakCores]))
      const memory = usage.flatMap((u) =>
        u.peakMemoryBytes === undefined ? [] : [u.peakMemoryBytes],
      )
      return [
        `${label}: ${usage.length} attempt${usage.length === 1 ? '' : 's'}`,
        `CPU ${cpu.toFixed(1)} s (avg ${cores(ms ? cpu / (ms / 1000) : 0)}${peaks.length ? `, peak ${cores(Math.max(...peaks))}` : ''} cores)`,
        memory.length ? `memory peak ${formatMemory(Math.max(...memory))}` : undefined,
        usage.some((u) => u.partial)
          ? `${usage.filter((u) => u.partial).length} partial`
          : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    })
    .join('; ')
}

/** One attempt's resources on one line, for its debug trace. */
export function resourcesLine(r: AttemptResources): string {
  const on = `${machineLabel(r.machine)} (${r.scope})`
  const u = r.usage
  if (!u) return `${on} · no readings`
  return [
    on,
    `CPU ${u.cpuSeconds.toFixed(1)} s over ${(u.durationMs / 1000).toFixed(1)} s (avg ${cores(u.avgCores)}${u.peakCores !== undefined ? `, peak ${cores(u.peakCores)}` : ''} cores)`,
    u.peakMemoryBytes !== undefined ? `memory peak ${formatMemory(u.peakMemoryBytes)}` : undefined,
    u.diskReadBytes !== undefined && u.diskWriteBytes !== undefined
      ? `disk ${formatMemory(u.diskReadBytes)} read, ${formatMemory(u.diskWriteBytes)} written`
      : undefined,
    u.partial ? 'partial: the sandbox went before the last reading' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}
