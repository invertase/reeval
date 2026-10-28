// `runs: { bestOf }` in an eval file's worker, where every attempt of a cell runs: the majority's
// first attempts start at once, and each later one waits for every earlier attempt of its cell to
// settle, then runs only while neither side has a majority. An infra error counts on neither side.
import type { Settled, TestOptions } from './engine/runtime.ts'
import { majorityOf } from './options.ts'

type Side = 'pass' | 'fail' | null

/** The side an attempt that settled counts on: its record's outcome, else the engine's state. */
export function sideOf({ state, meta }: Settled): Side {
  const outcome =
    meta?.outcome ?? (state === 'passed' ? 'pass' : state === 'failed' ? 'fail' : null)
  return outcome === 'pass' || outcome === 'fail' ? outcome : null
}

/** Whether a best-of cell still needs another attempt after these. */
export function undecided(sides: Side[], bestOf: number): boolean {
  const majority = majorityOf(bestOf)
  const pass = sides.filter((s) => s === 'pass').length
  const fail = sides.filter((s) => s === 'fail').length
  return pass < majority && fail < majority
}

/** One best-of cell: the `ready` and `settled` hooks of its attempt `n`, from 1 to `bestOf`. */
export function bestOfCell(bestOf: number): (n: number) => Pick<TestOptions, 'ready' | 'settled'> {
  const sides: Array<Promise<Side>> = []
  const settle: Array<(side: Side) => void> = []
  for (let n = 1; n <= bestOf; n++) {
    sides.push(new Promise<Side>((resolve) => settle.push(resolve)))
  }
  return (n) => ({
    ...(n > majorityOf(bestOf)
      ? { ready: async () => undecided(await Promise.all(sides.slice(0, n - 1)), bestOf) }
      : {}),
    settled: (settled) => settle[n - 1]?.(sideOf(settled)),
  })
}
