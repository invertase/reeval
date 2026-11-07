// An attempt's resources: the readings the sandbox's script prints, what they add up to, and the
// script itself run on this machine as a VM's would be.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import type { DockerSession } from '@reeval/sandbox-docker'
import {
  type Limits,
  parseLine,
  type Reading,
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
})

describe('resources', () => {
  test('parseLine reads the limits and a reading, `-` as nothing, and skips anything else', () => {
    assert.deepEqual(parseLine('limits max 100000 - 8 -', 5), {
      limits: { quota: null, period: 100_000, memory: null, cpus: 8, ticks: null },
    })
    assert.deepEqual(parseLine('s - 1500 2048 - -', 7), {
      reading: { at: 7, cpu: 1500, memory: 2048, read: null, written: null },
    })
    // The sandbox's uptime times the reading, not when the line reached the host.
    assert.equal((parseLine('s 12.34 1500 2048 - -', 7) as { reading: Reading }).reading.at, 12_340)
    assert.equal(parseLine('s - - 2048 - -', 7), null)
    assert.equal(parseLine('s 1500 2048 - -', 7), null)
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
        // The last pair is a tenth of an interval apart, too close to count.
        peakCores: 1.5,
        peakMemoryBytes: 300,
      },
    })
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
        { at: 0, cpu: 1000, memory: 10, read: 4096, written: 512 },
        { at: 2000, cpu: 1300, memory: 20, read: 8192, written: 1024 },
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
      peakMemoryBytes: 20,
      diskReadBytes: 4096,
      diskWriteBytes: 512,
    })
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
    const session = {
      spawn: async ({ command }: { command: string }) => {
        const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'ignore'] })
        children.push(child)
        return {
          pid: child.pid,
          stdout: Readable.toWeb(child.stdout),
          kill: async () => {
            calls.kill++
            child.kill('SIGKILL')
          },
        }
      },
      run: async ({ command }: { command: string }) => {
        calls.run++
        const r = await promisify(execFile)('bash', ['-c', command])
        return { exitCode: 0, stdout: r.stdout, stderr: r.stderr }
      },
    } as unknown as Pick<DockerSession, 'spawn' | 'run'>
    const meter = startMeter(session, 'machine', { sandbox: 'tart' }, 200)
    await new Promise((resolve) => setTimeout(resolve, 700))
    const r = await meter.stop({ gone: false })
    assert.equal(r.scope, 'machine')
    assert.ok((r.machine.vcpus ?? 0) >= 1, JSON.stringify(r))
    assert.ok((r.machine.memoryBytes ?? 0) > 0, JSON.stringify(r))
    assert.ok(r.usage && r.usage.durationMs >= 400, JSON.stringify(r))
    assert.equal(r.usage.partial, undefined)
    assert.ok(r.usage.peakCores !== undefined && (r.usage.peakMemoryBytes ?? 0) > 0)
    assert.equal(typeof r.usage.diskReadBytes, 'number')

    const gone = startMeter(session, 'machine', { sandbox: 'tart' }, 200)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const before = { ...calls }
    assert.equal((await gone.stop({ gone: true })).usage?.partial, true)
    assert.deepEqual(calls, before, 'a gone sandbox gets no final reading and no in-sandbox kill')
    assert.equal(children.at(-1)?.signalCode, 'SIGKILL')
  })
})
