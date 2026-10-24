// Pairs for pairwise questions, as pure data: which attempts are judged against which, the order
// each is shown in, and how the blinded picks map back to names and win rates. A run's staging
// records and recorded runs both feed it.
import { clip } from '../text.ts'
import type {
  CompareAnswer,
  CompareCut,
  ExecResult,
  FakeVote,
  FileChange,
  PairFactor,
  PairVote,
  TranscriptEvent,
} from '../types.ts'

/** One turn of a side: its prompt, final message and transcript, when the record has them. */
export type PairTurn = { prompt: string; text?: string; transcript?: readonly TranscriptEvent[] }

/** One attempt, as a question sees it. */
export type PairAttempt = {
  /** The harness id, e.g. `cursor:composer-2.5`. */
  harness: string
  /** The arm: the environment the attempt ran, e.g. `with-skill`. */
  arm: string
  /** The run number within its cell, from 1. */
  run: number
  /** The workspace changes, as a unified diff; empty when the agent changed nothing. */
  diff: string
  /** The changed files, for `state.files`; unset where only the patch is known. */
  files?: FileChange[]
  /** Passed, or failed only on a judge: its deterministic checks held. */
  checksPassed: boolean
  /** The compare's baseline arm, which goes first within a harness. */
  control?: boolean
  /** The turns it ran, for the task both sides were given and what `state` shows of each. */
  turns?: PairTurn[]
  /** Its `c.exec` results, in call order. */
  checks?: Array<{ command: string } & ExecResult>
  /** Its captures, in capture order, with each PNG's bytes when it was read. */
  captures?: Array<{ name: string; data: Uint8Array }>
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

/** Both pair kinds, in the order `pairsOf` builds them. */
export const ALL_CUTS: CompareCut[] = ['within', 'across']

/** A question's `across` as a list: empty when it's asked of each attempt on its own. */
export const pairFactors = (across?: PairFactor | readonly PairFactor[]): PairFactor[] =>
  across === undefined ? [] : typeof across === 'string' ? [across] : [...across]

/**
 * The pair kinds a pairwise question asks: `environment` varies the environment and holds the
 * harness (`within`); `harness` varies the harness and holds the environment (`across`).
 */
export const acrossOf = (across: PairFactor | readonly PairFactor[]): CompareCut[] => {
  const factors = pairFactors(across)
  return ALL_CUTS.filter((cut) => factors.includes(cut === 'within' ? 'environment' : 'harness'))
}

/**
 * The pairs to judge. Within a harness, for each run, every two environments; across harnesses,
 * for each environment and run, every two harnesses. Attempts that failed their deterministic
 * checks are left out (they still count in the pass rate), so a pair missing a side isn't
 * judged. The control environment comes first, then environments and harnesses in the order they
 * first appear. `kinds` keeps one pair kind; omitted or empty, both run.
 */
export function pairsOf(attempts: PairAttempt[], kinds?: readonly CompareCut[]): Pair[] {
  const eligible = attempts.filter((a) => a.checksPassed)
  const find = (harness: string, arm: string, run: number) =>
    eligible.find((a) => a.harness === harness && a.arm === arm && a.run === run)
  const harnesses = distinct(attempts.map((a) => a.harness))
  const arms = distinct([
    ...attempts.filter((a) => a.control).map((a) => a.arm),
    ...attempts.map((a) => a.arm),
  ])
  const runs = [...new Set(attempts.map((a) => a.run))].sort((x, y) => x - y)
  const want = new Set(kinds?.length ? kinds : ALL_CUTS)
  const pairs: Pair[] = []
  if (want.has('within')) {
    for (const harness of harnesses) {
      for (const run of runs) {
        for (const [x, y] of combinations(arms)) {
          const a = find(harness, x, run)
          const b = find(harness, y, run)
          if (a && b) pairs.push({ cut: 'within', harness, run, a, b })
        }
      }
    }
  }
  if (want.has('across')) {
    for (const arm of arms) {
      for (const run of runs) {
        for (const [x, y] of combinations(harnesses)) {
          const a = find(x, arm, run)
          const b = find(y, arm, run)
          if (a && b) pairs.push({ cut: 'across', arm, run, a, b })
        }
      }
    }
  }
  return pairs
}

/** Optimistic pair sides from planned attempts: every check is assumed to pass. */
export function plannedSides(
  attempts: Array<{
    cell: { harness: string; environment: string; role: string }
    n: number
  }>,
): PairAttempt[] {
  return attempts.map((a) => ({
    harness: a.cell.harness,
    arm: a.cell.environment,
    run: a.n,
    diff: '',
    checksPassed: true,
    control: a.cell.role === 'control',
  }))
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

/** Stored vote reasons are at most this long. */
export const VOTE_REASON_CAP = 200

/** Distinct stored reasons, in vote order, capped at `n`. */
export function sampleReasons(votes: PairVote[], n = 3): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of votes) {
    if (!v.reason || seen.has(v.reason)) continue
    seen.add(v.reason)
    out.push(v.reason)
    if (out.length >= n) break
  }
  return out
}

/** A stored reason: trimmed, capped, omitted when empty. */
export function voteReason(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  return clip(trimmed, VOTE_REASON_CAP)
}

/** The vote a pick makes, with the pair's names. */
export function voteOf(
  question: string,
  pair: Pair,
  swapped: boolean,
  pick: FakeVote,
  reason?: string,
): PairVote {
  const why = voteReason(reason)
  return {
    question,
    cut: pair.cut,
    ...(pair.cut === 'within' ? { harness: pair.harness } : { arm: pair.arm }),
    run: pair.run,
    a: sideName(pair.cut, pair.a),
    b: sideName(pair.cut, pair.b),
    winner: winnerOf(pair, swapped, pick),
    swapped,
    ...(why ? { reason: why } : {}),
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

/**
 * One pair of sides over a question's runs: each run's pair is voted twice, once per order, and
 * decides for a side only when both orders agree (or one is a tie). Orders that pick opposite
 * sides are a split: the pick followed the position, not the work.
 */
export type PairTally = {
  cut: CompareCut
  /** What both sides held: the harness within, the arm across. */
  held: string
  a: string
  b: string
  /** Runs voted on. */
  pairs: number
  aWins: number
  bWins: number
  ties: number
  splits: number
  /** Splits where each order picked the side shown first. */
  splitsFirst: number
}

/** Each pair of sides' head-to-head over its runs, in vote order. */
export function pairTallies(votes: PairVote[]): PairTally[] {
  const byPair = new Map<string, PairVote[]>()
  for (const v of votes) {
    const key = [v.cut, v.harness ?? v.arm ?? '', v.a, v.b, v.run].join('\0')
    byPair.set(key, [...(byPair.get(key) ?? []), v])
  }
  const tallies = new Map<string, PairTally>()
  for (const pair of byPair.values()) {
    const v = pair[0] as PairVote
    const key = [v.cut, v.harness ?? v.arm ?? '', v.a, v.b].join('\0')
    const t = tallies.get(key) ?? {
      cut: v.cut,
      held: v.harness ?? v.arm ?? '',
      a: v.a,
      b: v.b,
      pairs: 0,
      aWins: 0,
      bWins: 0,
      ties: 0,
      splits: 0,
      splitsFirst: 0,
    }
    tallies.set(key, t)
    t.pairs++
    const winners = new Set(pair.map((x) => x.winner).filter((w) => w !== 'tie'))
    if (winners.size === 0) t.ties++
    else if (winners.size > 1) {
      t.splits++
      if (pair.every((x) => x.winner === (x.swapped ? x.b : x.a))) t.splitsFirst++
    } else if (winners.has(v.a)) t.aWins++
    else t.bWins++
  }
  return [...tallies.values()]
}

/** `no-skill 1–0 new-skill (2 splits)`. */
export function pairTallyLabel(t: PairTally): string {
  const extra = [
    t.splits ? `${t.splits} split${t.splits === 1 ? '' : 's'}` : '',
    t.ties ? `${t.ties} tie${t.ties === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return `${t.a} ${t.aWins}–${t.bWins} ${t.b}${extra.length ? ` (${extra.join(', ')})` : ''}`
}

/**
 * How many pairs the two orders split on: `4/9 pairs split by order, all to the side shown
 * first`. Null when there are no votes.
 */
export function splitsLabel(tallies: PairTally[]): string | null {
  const pairs = tallies.reduce((n, t) => n + t.pairs, 0)
  if (!pairs) return null
  const splits = tallies.reduce((n, t) => n + t.splits, 0)
  const first = tallies.reduce((n, t) => n + t.splitsFirst, 0)
  const toFirst = !splits
    ? ''
    : first === splits
      ? ', all to the side shown first'
      : first === 0
        ? ', all to the side shown second'
        : `, ${first} to the side shown first`
  return `${splits}/${pairs} pairs split by order${toFirst}`
}

/**
 * Head-to-head lines for each cut where more than two sides met, which a pooled win rate blurs:
 * `within cursor:composer-2.5: no-skill 2–0 current-skill (1 split) · new-skill 2–0 current-skill`.
 */
export function headToHeadLines(votes: PairVote[]): string[] {
  const groups = new Map<string, PairTally[]>()
  for (const t of pairTallies(votes)) {
    const key = `${t.cut} ${t.held}`
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  return [...groups]
    .filter(([, ts]) => new Set(ts.flatMap((t) => [t.a, t.b])).size > 2)
    .map(([key, ts]) => `${key}: ${ts.map(pairTallyLabel).join(' · ')}`)
}
