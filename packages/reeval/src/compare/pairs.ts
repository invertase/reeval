// Pairs for compare questions, as pure data: which attempts are judged against which, the order
// each is shown in, and how the blinded picks map back to names and win rates. A run's staging
// records and recorded runs both feed it.
import type { CompareAnswer, CompareCut, FakeVote, PairVote } from '../types.ts'

/** One attempt, as a compare question sees it. */
export type PairAttempt = {
  /** The harness id, e.g. `cursor:composer-2.5`. */
  harness: string
  /** The arm: the environment the attempt ran, e.g. `with-skill`. */
  arm: string
  /** The run number within its cell, from 1. */
  run: number
  /** The workspace changes, as a unified diff; empty when the agent changed nothing. */
  diff: string
  /** Passed, or failed only on a judge: its deterministic checks held. */
  checksPassed: boolean
  /** The prompts it was sent, for the task both sides were given. */
  prompts?: string[]
  /** The attempt's id, e.g. `cursor/-/docker#1`; never shown to the model. */
  id?: string
}

export type Pair = {
  cut: CompareCut
  /** Within: the harness both sides ran on. */
  harness?: string
  /** Across: the arm both sides ran. */
  arm?: string
  run: number
  a: PairAttempt
  b: PairAttempt
}

/** The side a pair names: an arm within a harness, a harness across them. */
export const sideName = (cut: CompareCut, side: PairAttempt) =>
  cut === 'within' ? side.arm : side.harness

/** Every two-element combination, in the order given. */
function combinations<T>(items: T[]): Array<[T, T]> {
  const out: Array<[T, T]> = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i] as T, items[j] as T])
  }
  return out
}

/** Distinct values in first-seen order. */
const distinct = (values: string[]) => [...new Set(values)]

/**
 * The pairs to judge. Within a harness, for each run, every two arms; across harnesses, for each
 * arm and run, every two harnesses. Attempts that failed their deterministic checks are left out
 * (they still count in the pass rate), so a pair missing a side isn't judged. Sides are ordered as
 * they first appear, so the baseline (planned first) is `a` within a harness.
 */
export function pairsOf(attempts: PairAttempt[]): Pair[] {
  const eligible = attempts.filter((a) => a.checksPassed)
  const find = (harness: string, arm: string, run: number) =>
    eligible.find((a) => a.harness === harness && a.arm === arm && a.run === run)
  const harnesses = distinct(attempts.map((a) => a.harness))
  const arms = distinct(attempts.map((a) => a.arm))
  const runs = [...new Set(attempts.map((a) => a.run))].sort((x, y) => x - y)
  const pairs: Pair[] = []
  for (const harness of harnesses) {
    for (const run of runs) {
      for (const [x, y] of combinations(arms)) {
        const a = find(harness, x, run)
        const b = find(harness, y, run)
        if (a && b) pairs.push({ cut: 'within', harness, run, a, b })
      }
    }
  }
  for (const arm of arms) {
    for (const run of runs) {
      for (const [x, y] of combinations(harnesses)) {
        const a = find(x, arm, run)
        const b = find(y, arm, run)
        if (a && b) pairs.push({ cut: 'across', arm, run, a, b })
      }
    }
  }
  return pairs
}

/** The two sides in the order the model sees them: `a` first, or `b` first when swapped. */
export const slots = (pair: Pair, swapped: boolean): [PairAttempt, PairAttempt] =>
  swapped ? [pair.b, pair.a] : [pair.a, pair.b]

/** Maps a blinded pick (`A` is the first slot) back to the side's name. */
export function winnerOf(pair: Pair, swapped: boolean, pick: FakeVote): string | 'tie' {
  if (pick === 'tie') return 'tie'
  const [first, second] = slots(pair, swapped)
  return sideName(pair.cut, pick === 'A' ? first : second)
}

/** The vote a pick makes, with the pair's names. */
export function voteOf(question: string, pair: Pair, swapped: boolean, pick: FakeVote): PairVote {
  return {
    question,
    cut: pair.cut,
    ...(pair.cut === 'within' ? { harness: pair.harness } : { arm: pair.arm }),
    run: pair.run,
    a: sideName(pair.cut, pair.a),
    b: sideName(pair.cut, pair.b),
    winner: winnerOf(pair, swapped, pick),
    swapped,
  }
}

/**
 * Each side's wins over the decided votes it was in, per cut. A tie decides nothing, so it counts
 * for neither side; both orders of a pair count, since each is its own judgement.
 */
export function ratesOf(votes: PairVote[]): CompareAnswer['rates'] {
  const rates = new Map<string, CompareAnswer['rates'][number]>()
  const rate = (cut: CompareCut, name: string) => {
    const key = `${cut}\0${name}`
    let found = rates.get(key)
    if (!found) {
      found = { cut, name, wins: 0, n: 0 }
      rates.set(key, found)
    }
    return found
  }
  for (const v of votes) {
    if (v.winner === 'tie') continue
    for (const name of [v.a, v.b]) {
      const r = rate(v.cut, name)
      r.n++
      if (v.winner === name) r.wins++
    }
  }
  const order: CompareCut[] = ['within', 'across']
  return [...rates.values()].sort((x, y) => order.indexOf(x.cut) - order.indexOf(y.cut))
}
