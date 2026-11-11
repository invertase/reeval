// An eval with `cases` is one record entry: its cells over every case, each case's own cells in
// `cases`, and each attempt's `case`. A run plans and assembles each case as an entry of its own
// (`family` set, named `<eval> [<key>]`), so attempts, resume and artifacts keep their keys;
// `foldCases` turns those entries, and the `families` beside them, into the eval, and
// `unfoldCases` turns it back. Browser-safe: reading a record from before this shape folds it too.
import { sha256Hex } from '../sha256.ts'
import { evalSlug } from '../slug.ts'
import type { Outcome } from '../types.ts'
import { checkVerdict } from '../view/contrasts.ts'
import { caseLabel, templateName } from '../view/family.ts'
import { passRateOf, worstOutcome } from '../view/gate.ts'
import type {
  CaseRecord,
  CellRecord,
  EvalEntry,
  FamilyRate,
  FamilyRecord,
  FingerprintParts,
  RunRecord,
} from './types.ts'

/**
 * Each cell's checks: every label any attempt of the eval recorded, tallied over the cell's
 * counted attempts (pass or fail). An attempt that counted without reaching a label, because
 * an `expect.require` or a thrown error before it ended the body, counts it `notRun`.
 */
export function checkTallies(entry: Pick<EvalEntry, 'attempts' | 'cells'>): void {
  const labels = [
    ...new Set(entry.attempts.flatMap((a) => (a.assertions ?? []).map((x) => x.label))),
  ]
  if (!labels.length) return
  for (const c of entry.cells) {
    const counted = entry.attempts.filter(
      (a) => a.cell === c.key && (a.outcome === 'pass' || a.outcome === 'fail'),
    )
    if (!counted.length) continue
    c.checks = labels.map((label) => {
      const tally = { label, pass: 0, fail: 0, error: 0, notRun: 0, notApplicable: 0 }
      for (const a of counted) {
        const status = a.assertions?.find((x) => x.label === label)?.status
        if (status === undefined) tally.notRun++
        else if (status === 'not_applicable') tally.notApplicable++
        else tally[status]++
      }
      return tally
    })
  }
}

/** Puts the control's tally beside each of the variant's checks, with whether it discriminates. */
export function discrimination(control: CellRecord, variant: CellRecord): void {
  for (const check of variant.checks ?? []) {
    const k = control.checks?.find((x) => x.label === check.label)
    if (!k) continue
    const { label: _label, ...tally } = k
    check.control = tally
    const verdict = checkVerdict(check, k)
    if (verdict) check.verdict = verdict
  }
}

/** The control a variant cell is measured against: the control on its harness and sandbox. */
export const controlOf = (cells: readonly CellRecord[], variant: CellRecord) =>
  cells.find(
    (x) => x.role === 'control' && x.harness === variant.harness && x.sandbox === variant.sandbox,
  )

/** The member name a case ran under: `adds a check [nextjs]`. */
export const caseName = (e: Pick<EvalEntry, 'name'>, c: Pick<CaseRecord, 'key' | 'name'>) =>
  c.name ?? `${e.name} [${c.key}]`

/** A case's key from the member name it ran under, or a template's label in an older record. */
export const caseKeyOf = caseLabel

/** One cell over every case that has it, gated on its rate when the eval's `passRate` pools. */
function mergeCell(
  key: string,
  members: readonly EvalEntry[],
  caseKeys: readonly string[],
  rate: FamilyRate | undefined,
  liftFailed: boolean,
): CellRecord {
  const pairs = members.flatMap((m, i) =>
    m.cells.filter((c) => c.key === key).map((c) => [caseKeys[i] as string, c] as const),
  )
  const cells = pairs.map(([, c]) => c)
  const { lift: _lift, checks: _checks, ...first } = cells[0] as CellRecord
  const parts = mergedParts(pairs)
  const sum = (pick: (c: CellRecord) => number) => cells.reduce((s, c) => s + pick(c), 0)
  const pass = sum((c) => c.pass)
  const fail = sum((c) => c.fail)
  const pooled = pass + fail > 0 ? rate?.outcome : undefined
  let outcome: Outcome = pooled ?? worstOutcome(cells.map((c) => c.outcome))
  if (liftFailed && outcome === 'pass') outcome = 'fail'
  const { cell: _cell, ...cellRate } = rate ?? ({} as FamilyRate)
  return {
    ...first,
    fingerprint:
      parts === first.fingerprintParts ? first.fingerprint : sha256Hex(JSON.stringify(parts)),
    fingerprintParts: parts,
    runs: sum((c) => c.runs),
    pass,
    fail,
    infraError: sum((c) => c.infraError),
    skipped: sum((c) => c.skipped),
    passRate: pass + fail ? pass / (pass + fail) : null,
    outcome,
    ...(rate ? { rate: cellRate } : {}),
  }
}

/**
 * A cell's fingerprint parts over its cases: a part every case shares as it is, one that differs
 * (each case's data is in `sources`) hashed over every case's, so a change to any case changes it.
 */
function mergedParts(pairs: ReadonlyArray<readonly [string, CellRecord]>): FingerprintParts {
  const first = (pairs[0] as readonly [string, CellRecord])[1].fingerprintParts
  const keys = [...new Set(pairs.flatMap(([, c]) => Object.keys(c.fingerprintParts)))] as Array<
    keyof FingerprintParts
  >
  const differs = keys.filter((k) => pairs.some(([, c]) => c.fingerprintParts[k] !== first[k]))
  if (!differs.length) return first
  const parts = { ...first }
  for (const k of differs) {
    const over = pairs.map(([key, c]) => [key, c.fingerprintParts[k] ?? null])
    ;(parts as Record<string, string | null>)[k] = sha256Hex(JSON.stringify(over))
  }
  return parts
}

function caseOf(member: EvalEntry, template: string): CaseRecord {
  const family = member.family as NonNullable<EvalEntry['family']>
  const key = caseKeyOf(template, member.name)
  return {
    key,
    index: family.case,
    ...(member.name !== `${template} [${key}]` ? { name: member.name } : {}),
    ...(member.source?.case !== undefined ? { hash: member.source.case } : {}),
    outcome: member.outcome,
    ...(member.verdict ? { verdict: member.verdict } : {}),
    passRate: member.passRate,
    fingerprint: member.fingerprint,
    cells: member.cells,
    ...(member.excluded?.length ? { excluded: member.excluded } : {}),
    ...(member.answers?.length ? { answers: member.answers } : {}),
  }
}

/**
 * One eval from its cases' entries, in list order, with what `family` pooled over them. A family
 * whose cases were named from a template keeps the template as its name, which its cases' labels
 * come from, and takes the id of the eval with `cases` it ports to, named for `templateName`,
 * unless another eval in the record (`taken`) has that id.
 */
function foldOne(
  members: EvalEntry[],
  family: FamilyRecord | undefined,
  taken: ReadonlySet<string>,
): EvalEntry {
  const sorted = [...members].sort((a, b) => (a.family?.case ?? 0) - (b.family?.case ?? 0))
  const first = sorted[0] as EvalEntry
  const meta = first.family as NonNullable<EvalEntry['family']>
  const template = family?.name ?? meta.name
  const templated = sorted.some(
    (m) => !(m.name.startsWith(`${template} [`) && m.name.endsWith(']')),
  )
  const renamed = templated ? templateName(template) : template
  const renamedId = [first.file, ...first.group, renamed].join(' › ')
  const id = renamed === template || taken.has(renamedId) ? (family?.id ?? meta.id) : renamedId
  const name = template
  const cases = sorted.map((m) => caseOf(m, template))
  const attempts = sorted.flatMap((m, i) => {
    const key = (cases[i] as CaseRecord).key
    return m.attempts.map((a) => ({ ...a, case: key, id: `${a.cell}#${key}#${a.n}` }))
  })
  const several = meta.cases >= 2
  const keys: string[] = []
  for (const m of sorted) for (const c of m.cells) if (!keys.includes(c.key)) keys.push(c.key)
  const lifts = several ? (family?.lifts ?? []) : []
  const cells = several
    ? keys.map((key) =>
        mergeCell(
          key,
          sorted,
          cases.map((c) => c.key),
          family?.rates.find((r) => r.cell === key),
          lifts.some((l) => l.variant === key && l.outcome === 'fail'),
        ),
      )
    : first.cells.map((c) => ({ ...c }))
  if (several) {
    checkTallies({ attempts, cells })
    for (const c of cells) {
      const control = c.role === 'variant' ? controlOf(cells, c) : undefined
      if (control) discrimination(control, c)
    }
  }
  const gated = new Set(cells.filter((c) => c.gate !== 'none').map((c) => c.key))
  const excluded = family?.excluded ?? sorted.flatMap((m) => m.excluded ?? [])
  const { case: _case, ...source } = first.source ?? ({} as NonNullable<EvalEntry['source']>)
  const {
    family: _family,
    verdict: _verdict,
    answers: _answers,
    excluded: _excluded,
    source: _source,
    ...rest
  } = first
  return {
    ...rest,
    id,
    key: id,
    slug: evalSlug(id),
    name,
    ...(several
      ? {
          fingerprint: sha256Hex(JSON.stringify(cells.map((c) => [c.key, c.fingerprint]).sort())),
        }
      : {}),
    ...(first.source ? { source: source as EvalEntry['source'] } : {}),
    outcome: worstOutcome(
      cells.map((c) => (c.gate === 'none' && c.outcome === 'fail' ? 'pass' : c.outcome)),
    ),
    todo: sorted.every((m) => m.todo),
    passRate: passRateOf(attempts.filter((a) => gated.has(a.cell)).map((a) => a.outcome)),
    cells,
    attempts,
    ...(excluded.length ? { excluded } : {}),
    cases,
    caseCount: family?.cases ?? meta.cases,
    ...(lifts.length ? { lifts } : {}),
  }
}

/**
 * An eval with one case in a record that gave it no `family`: its case's hash and its
 * `<eval> [<key>]` name mark it. Any other entry is returned as it is.
 */
function loneCase(e: EvalEntry): EvalEntry {
  if (e.family || e.source?.case === undefined) return e
  const name = /^(.*) \[[^\]]*\]$/.exec(e.name)?.[1]
  if (!name) return e
  const id = [e.file, ...e.group, name].join(' › ')
  return { ...e, family: { id, name, case: 0, cases: 1 } }
}

/**
 * The record with each eval with `cases` as one entry: the entries its cases ran as (`family`)
 * folded in, at the first one's place, and `families` gone. A record without them is returned
 * as it is.
 */
export function foldCases(record: RunRecord): RunRecord {
  // Entries of `evaluate.each(cases, { pool: false })` share a name like this too; only one alone
  // is a lone case.
  const lone = record.evals.map(loneCase)
  const ids = lone.map((e, i) => (e !== record.evals[i] ? e.family?.id : undefined))
  const all = lone.map((e, i) =>
    ids[i] !== undefined && ids.filter((id) => id === ids[i]).length > 1
      ? (record.evals[i] as EvalEntry)
      : e,
  )
  if (!all.some((e) => e.family) && !record.families) return record
  const families = new Map((record.families ?? []).map((f) => [f.id, f]))
  const members = new Map<string, EvalEntry[]>()
  for (const e of all) {
    if (!e.family) continue
    members.set(e.family.id, [...(members.get(e.family.id) ?? []), e])
  }
  const taken = new Set(all.flatMap((e) => (e.family ? [e.family.id] : [e.id])))
  const evals: EvalEntry[] = []
  for (const e of all) {
    if (!e.family) {
      evals.push(e)
      continue
    }
    const group = members.get(e.family.id)
    if (!group) continue
    members.delete(e.family.id)
    const folded = foldOne(group, families.get(e.family.id), taken)
    taken.add(folded.id)
    evals.push(folded)
  }
  const { families: _families, ...rest } = record
  return { ...rest, evals, summary: { ...record.summary, evals: evals.length } }
}

/** The entries an eval with `cases` ran as, one per case in list order, each with `family`. */
export function caseEntries(e: EvalEntry): EvalEntry[] {
  if (!e.cases) return [e]
  const { cases, caseCount, lifts: _lifts, excluded: _excluded, ...rest } = e
  return cases.map((c): EvalEntry => {
    const name = caseName(e, c)
    const id = [e.file, ...e.group, name].join(' › ')
    return {
      ...rest,
      id,
      key: id,
      slug: evalSlug(id),
      name,
      ...(e.source ? { source: { ...e.source, ...(c.hash ? { case: c.hash } : {}) } } : {}),
      outcome: c.outcome,
      ...(c.verdict ? { verdict: c.verdict } : {}),
      passRate: c.passRate,
      fingerprint: c.fingerprint,
      cells: c.cells,
      attempts: e.attempts
        .filter((a) => a.case === c.key)
        .map(({ case: _case, ...a }) => ({ ...a, id: `${a.cell}#${a.n}` })),
      ...(c.answers?.length ? { answers: c.answers } : {}),
      family: { id: e.id, name: e.name, case: c.index, cases: caseCount ?? cases.length },
      ...(c.excluded?.length ? { excluded: c.excluded } : {}),
    }
  })
}

/** An eval with `cases` as `foldCases` read it: its cells' rates and lifts, as a family. */
export function familyOf(e: EvalEntry): FamilyRecord | undefined {
  if (!e.cases) return undefined
  const rates = e.cells.flatMap((c) => (c.rate ? [{ cell: c.key, ...c.rate }] : []))
  const lifts = e.lifts ?? []
  return {
    id: e.id,
    file: e.file,
    group: e.group,
    name: e.name,
    cases: e.caseCount ?? e.cases.length,
    ran: e.cases.filter((c) => e.attempts.some((a) => a.case === c.key && a.outcome !== 'skipped'))
      .length,
    rates,
    lifts,
    ...(e.excluded?.length ? { excluded: e.excluded } : {}),
    outcome: [...rates, ...lifts].some((x) => x.outcome === 'fail') ? 'fail' : 'pass',
  }
}

/**
 * The record as a run plans and assembles it: each eval with `cases` back as its cases' entries,
 * with `families`. What `foldCases` folds, this undoes, so a resume finds each attempt where it ran.
 */
export function unfoldCases(record: RunRecord): RunRecord {
  if (!record.evals.some((e) => e.cases)) return record
  const families = record.evals.flatMap((e) => familyOf(e) ?? [])
  return {
    ...record,
    evals: record.evals.flatMap(caseEntries),
    ...(families.length ? { families } : {}),
  }
}
