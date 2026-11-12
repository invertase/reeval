// An attempt's resources: the readings the sandbox's script prints, what they add up to, and the
// script itself run on this machine as a VM's would be.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import {
  type Limits,
  parseLine,
  type Reading,
  type SamplerHost,
  startMeter,
  summarize,
} from '../src/sandbox/resources.ts'
import { runResourcesLine } from '../src/view/resources.ts'

const containerLimits: Limits = {
  quota: 200_000,
  period: 100_000,
  memory: 4 * 1024 ** 3,
  cpus: 16,
  ticks: null,
}
const at = (s: number, cpu: number, memory: number | null = null): Reading => ({
  at: s * 1000,
  cpu,
  memory,
  read: null,
  written: null,
  memoryPeak: null,
  periods: null,
  throttled: null,
  throttledUsec: null,
})

describe('resources', () => {
  test('parseLine reads the limits and a reading, `-` as nothing, and skips anything else', () => {
    assert.deepEqual(parseLine('limits max 100000 - 8 -', 5), {
      limits: { quota: null, period: 100_000, memory: null, cpus: 8, ticks: null },
    })
    assert.deepEqual(parseLine('s - 1500 2048 - - 4096 10 3 25000', 7), {
      reading: {
        at: 7,
        cpu: 1500,
        memory: 2048,
        read: null,
        written: null,
        memoryPeak: 4096,
        periods: 10,
        throttled: 3,
        throttledUsec: 25_000,
      },
    })
    // The sandbox's uptime times the reading, not when the line reached the host.
    const timed = parseLine('s 12.34 1500 2048 - - - - - -', 7) as { reading: Reading }
    assert.equal(timed.reading.at, 12_340)
    assert.equal(parseLine('s - - 2048 - - - - - -', 7), null)
    assert.equal(parseLine('s 1500 2048 - - - - - -', 7), null)
    assert.equal(parseLine('s - 1500 2048 - -', 7), null)
    assert.equal(parseLine('sh: 1: nproc: not found', 7), null)
  })

  test("a container's quota is its vCPUs, and usec over the readings its CPU time", () => {
    const r = summarize(
      'container',
      { sandbox: 'docker' },
      containerLimits,
      [at(0, 0, 100), at(1, 500_000, 300), at(2, 2_000_000, 200), at(2.1, 2_100_000, 250)],
      { sampleMs: 1000, partial: false },
    )
    assert.deepEqual(r, {
      scope: 'container',
      machine: { sandbox: 'docker', vcpus: 2, memoryBytes: 4 * 1024 ** 3 },
      usage: {
        durationMs: 2100,
        sampleMs: 1000,
        cpuSeconds: 2.1,
        avgCores: 1,
        // The last reading is a tenth of an interval on, so it joins the second before it.
        peakCores: 1.455,
        p95Cores: 1.455,
        peakMemoryBytes: 300,
      },
    })
  })

  test('the average is never above the peak, however close the last reading comes', () => {
    // Three seconds at 2.2 cores, then a fifth of a second at 2.3 as the attempt ends.
    const readings = [0, 1, 2, 3].map((s) => at(s, s * 2_200_000))
    readings.push(at(3.21, 6_600_000 + 483_000))
    const u = summarize('container', { sandbox: 'docker' }, containerLimits, readings, {
      sampleMs: 1000,
      partial: false,
    }).usage
    assert.equal(u?.avgCores, 2.207)
    assert.equal(u?.peakCores, 2.217)
    assert.ok((u?.avgCores ?? 0) <= (u?.peakCores ?? 0), JSON.stringify(u))
    // Every reading within half an interval of the first: no sample to have a peak of.
    const short = summarize(
      'container',
      { sandbox: 'docker' },
      containerLimits,
      [at(0, 0), at(0.2, 100_000), at(0.4, 300_000)],
      { sampleMs: 1000, partial: false },
    ).usage
    assert.equal(short?.avgCores, 0.75)
    assert.equal(short?.peakCores, undefined)
  })

  test('no quota falls back to the CPUs it sees; one reading has no usage; a cut-short one is partial', () => {
    const limits = { ...containerLimits, quota: null, memory: null }
    assert.deepEqual(
      summarize('container', { sandbox: 'podman' }, limits, [at(0, 0)], {
        sampleMs: 1000,
        partial: true,
      }),
      { scope: 'container', machine: { sandbox: 'podman', vcpus: 16 } },
    )
    const partial = summarize('container', { sandbox: 'docker' }, limits, [at(0, 0), at(1, 10)], {
      sampleMs: 1000,
      partial: true,
    })
    assert.equal(partial.usage?.partial, true)
    assert.equal(partial.usage?.peakMemoryBytes, undefined)
  })

  test("a VM's CPU is in clock ticks, and its disks count", () => {
    const r = summarize(
      'machine',
      { sandbox: 'boat', size: 'small' },
      { quota: null, period: null, memory: 4_000_000_000, cpus: 2, ticks: 100 },
      [
        { ...at(0, 1000, 10), read: 4096, written: 512 },
        { ...at(2, 1300, 20), read: 8192, written: 1024 },
      ],
      { sampleMs: 1000, partial: false },
    )
    assert.deepEqual(r.machine, { sandbox: 'boat', size: 'small', vcpus: 2, memoryBytes: 4e9 })
    assert.deepEqual(r.usage, {
      durationMs: 2000,
      sampleMs: 1000,
      cpuSeconds: 3,
      avgCores: 1.5,
      peakCores: 1.5,
      p95Cores: 1.5,
      peakMemoryBytes: 20,
      diskReadBytes: 4096,
      diskWriteBytes: 512,
    })
  })

  test("p95 is the nearest-rank 95th percentile of each second's cores; throttling and memory.peak are a container's", () => {
    const counters = (s: number, cpu: number, n: number, peak: number): Reading => ({
      ...at(s, cpu, 100),
      memoryPeak: peak,
      periods: n * 10,
      throttled: n * 4,
      throttledUsec: n * 200_000,
    })
    // Twenty seconds at 0.5 cores, then one at 2: the one is the busiest twentieth.
    const readings = Array.from({ length: 21 }, (_, s) => counters(s, s * 500_000, s, 1000 + s))
    readings.push(counters(21, 10_000_000 + 2_000_000, 21, 900))
    const u = summarize('container', { sandbox: 'docker' }, containerLimits, readings, {
      sampleMs: 1000,
      partial: false,
    }).usage
    assert.equal(u?.peakCores, 2)
    assert.equal(u?.p95Cores, 0.5)
    assert.equal(u?.cgroupPeakMemoryBytes, 1020)
    assert.deepEqual(u?.throttling, { periods: 210, throttledPeriods: 84, throttledSeconds: 4.2 })
    const vm = summarize('machine', { sandbox: 'boat' }, null, [at(0, 0), at(1, 50)], {
      sampleMs: 1000,
      partial: false,
    })
    assert.equal(vm.usage, undefined, 'no clock ticks, no usage')
  })

  test('runResourcesLine sums each machine and is null without readings', () => {
    const one = summarize(
      'container',
      { sandbox: 'docker' },
      containerLimits,
      [at(0, 0, 5 << 20), at(2, 1_000_000, 300 << 20)],
      {
        sampleMs: 1000,
        partial: false,
      },
    )
    assert.equal(
      runResourcesLine([one, one, undefined]),
      'docker 2 vCPU 4.0 GiB: 2 attempts · CPU 2.0 s (avg 0.50, peak 0.50 cores) · memory peak 300 MiB',
    )
    assert.equal(runResourcesLine([undefined]), null)
  })

  test('the script reads this machine as a VM, until stop takes the last reading', {
    skip: process.platform !== 'linux' && 'reads /proc',
  }, async () => {
    const calls = { kill: 0, run: 0 }
    const children: ReturnType<typeof spawn>[] = []
    const host = bashHost(calls, children)
    const meter = startMeter([host], 'machine', { sandbox: 'boat' }, 200)
    await new Promise((resolve) => setTimeout(resolve, 700))
    const r = await meter.stop({ gone: false })
    assert.equal(r.scope, 'machine')
    assert.ok((r.machine.vcpus ?? 0) >= 1, JSON.stringify(r))
    assert.ok((r.machine.memoryBytes ?? 0) > 0, JSON.stringify(r))
    assert.ok(r.usage && r.usage.durationMs >= 400, JSON.stringify(r))
    assert.equal(r.usage.partial, undefined)
    assert.ok(r.usage.peakCores !== undefined && (r.usage.peakMemoryBytes ?? 0) > 0)
    assert.ok((r.usage.p95Cores ?? 99) <= r.usage.peakCores, JSON.stringify(r))
    assert.equal(typeof r.usage.diskReadBytes, 'number')
    assert.equal(r.usage.throttling, undefined)
    assert.equal(r.usage.cgroupPeakMemoryBytes, undefined)

    const gone = startMeter([host], 'machine', { sandbox: 'boat' }, 200)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const before = { ...calls }
    assert.equal((await gone.stop({ gone: true })).usage?.partial, true)
    assert.deepEqual(calls, before, 'a gone sandbox gets no final reading and no in-sandbox kill')
    assert.equal(children.at(-1)?.signalCode, 'SIGKILL')
  })

  test('a macOS VM reads its sizes from sysctl and has no usage', {
    skip: process.platform === 'win32' && 'runs sh',
  }, async () => {
    const bin = mkdtempSync(join(tmpdir(), 'reeval-sysctl-'))
    writeFileSync(
      join(bin, 'sysctl'),
      '#!/bin/sh\ncase $2 in hw.memsize) echo 17179869184 ;; hw.ncpu) echo 4 ;; *) exit 1 ;; esac\n',
      { mode: 0o755 },
    )
    const host = bashHost({ kill: 0, run: 0 }, [], { PATH: `${bin}:${process.env.PATH}` })
    const meter = startMeter([host], 'darwin', { sandbox: 'tart' }, 200)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await meter.stop({ gone: false }), {
      scope: 'machine',
      machine: { sandbox: 'tart', vcpus: 4, memoryBytes: 16 * 1024 ** 3 },
    })
  })

  test('the last reading waits for a sampler that starts after the attempt ended', {
    skip: process.platform !== 'linux' && 'reads /proc',
  }, async (t) => {
    const calls = { kill: 0, run: 0 }
    const children: ReturnType<typeof spawn>[] = []
    t.after(() => {
      for (const c of children) c.kill('SIGKILL')
    })
    const bash = bashHost(calls, children)
    let running = false
    const late: SamplerHost = {
      spawn: async ({ command }) => {
        setTimeout(() => {
          running = true
        }, 500)
        return bash.spawn({ command: `sleep 0.5; ${command}` })
      },
      // As `docker exec` into an observer whose container hasn't started.
      run: async (o) => (running ? bash.run(o) : { exitCode: 1, stdout: '' }),
    }
    const meter = startMeter([late], 'machine', { sandbox: 'boat' }, 200)
    const r = await meter.stop({ gone: false })
    assert.ok((r.machine.vcpus ?? 0) >= 1, JSON.stringify(r))
    assert.ok((r.machine.memoryBytes ?? 0) > 0, JSON.stringify(r))
    assert.equal(r.usage?.partial, undefined, JSON.stringify(r))
    assert.equal(calls.run, 1)
  })

  test('ready waits for the readings to begin, but not past an abort', {
    skip: process.platform !== 'linux' && 'reads /proc',
  }, async (t) => {
    const children: ReturnType<typeof spawn>[] = []
    t.after(() => {
      for (const c of children) c.kill('SIGKILL')
    })
    const bash = bashHost({ kill: 0, run: 0 }, children)
    const late: SamplerHost = {
      spawn: ({ command }) => bash.spawn({ command: `sleep 0.5; ${command}` }),
      run: bash.run,
    }
    const meter = startMeter([late], 'machine', { sandbox: 'boat' }, 200)
    const from = performance.now()
    await meter.ready()
    assert.ok(performance.now() - from >= 450)
    await meter.stop({ gone: false })

    const stuck = startMeter(
      [{ spawn: () => new Promise(() => {}), run: async () => ({ exitCode: 1, stdout: '' }) }],
      'machine',
      { sandbox: 'boat' },
    )
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const at = performance.now()
    await stuck.ready(controller.signal)
    assert.ok(performance.now() - at < 1000)
    await stuck.stop({ gone: true })
  })

  test('a host whose script ends without its limits hands over to the next', {
    skip: process.platform !== 'linux' && 'reads /proc',
  }, async () => {
    const calls = { kill: 0, run: 0 }
    const silent: SamplerHost = {
      spawn: async () => ({
        pid: undefined,
        stdout: Readable.toWeb(
          Readable.from([Buffer.from('nothing to read here\n')]),
        ) as ReadableStream<Uint8Array>,
        kill: async () => {
          calls.kill++
        },
      }),
      run: async () => {
        throw new Error('the silent host takes no final reading')
      },
    }
    const refused: SamplerHost = {
      spawn: async () => {
        throw new Error('no observer')
      },
      run: async () => ({ exitCode: 1, stdout: '' }),
    }
    const meter = startMeter(
      [refused, silent, bashHost(calls, [])],
      'machine',
      { sandbox: 'boat' },
      200,
    )
    await new Promise((resolve) => setTimeout(resolve, 700))
    const r = await meter.stop({ gone: false })
    assert.equal(r.usage?.partial, undefined, JSON.stringify(r))
    assert.ok((r.machine.vcpus ?? 0) >= 1)
    assert.equal(calls.run, 1, 'the final reading runs where the readings came from')
    assert.equal(calls.kill, 2, 'the silent host and, at stop, the one that read')
  })
})

/** Runs the script with bash on this machine, counting its runs and kills. */
function bashHost(
  calls: { kill: number; run: number },
  children: ReturnType<typeof spawn>[],
  env: Record<string, string | undefined> = process.env,
): SamplerHost {
  return {
    spawn: async ({ command }) => {
      const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'ignore'], env })
      children.push(child)
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        kill: async () => {
          calls.kill++
          child.kill('SIGKILL')
        },
      }
    },
    run: async ({ command }) => {
      calls.run++
      const r = await promisify(execFile)('bash', ['-c', command], { env })
      return { exitCode: 0, stdout: r.stdout }
    },
  }
}
