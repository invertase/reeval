// `reeval/renderer/markdown`: a `RunReport` as Markdown, the one renderer behind summary.md,
// `reeval show --md`, `reeval compare --md`, the MCP server's `md` and `reeval analyze --save`.

import { medianWithDelta } from '../view/report/format.ts'
import { attemptAnchorId } from '../view/report/ids.ts'
import {
  COMPARE_STATUS_LABEL,
  contrastMeasureLabel,
  DISCOVERY_SOURCE_LABEL,
  MEASURE_LABEL,
  PASS_RATE_OUTCOME_LABEL,
  verdictLabel,
} from '../view/report/labels.ts'
import type {
  ArmRow,
  AssertionRow,
  AttemptIndexRow,
  AttemptRef,
  BlockMarkdown,
  BreakdownRow,
  CaptureGallery,
  ChoiceBreakdown,
  ContrastRow,
  DiscoveryRate,
  EvalHeadline,
  EvalSection,
  ExecutiveRollup,
  FailureClusters,
  HeadlinePrimary,
  IntegrityIssue,
  JudgmentBreakdown,
  MeasureKey,
  ProvenanceState,
  QualitativeAnswers,
  RegressionChanges,
  ReportClaim,
  RosterRow,
  RunHeader,
  RunReport,
  TaskResults,
  VariantComparison,
} from '../view/report/types.ts'

export type { BlockMarkdown } from '../view/report/types.ts'

/** Shared by summary tests and reeval-components check-text. */
export const FORBIDDEN_OUTPUT = [
  { name: 'em or en dash', pattern: /[\u2013\u2014]/ },
  { name: 'arrow', pattern: /[\u2190-\u21ff\u27f0-\u27ff]|-[>]|=[>]/ },
  { name: 'status glyph or emoji', pattern: /[\u2713\u2717\u25cb]|\p{Extended_Pictographic}/u },
  { name: 'Yes or No value', pattern: /\|\s*(Yes|No)\s*\||\*\*(Yes|No)\b/ },
  { name: 'blank cell', pattern: /\|[ \t]*\|(?![-: |]*$)/m },
  { name: 'text dump', pattern: /^`{3}text$/m },
  { name: 'scratch path', pattern: /\.reeval\/runs\// },
  { name: 'bold pseudo-heading', pattern: /^\*\*[^*]+\.\*\*$/m },
] as const

const MEASURE_ORDER: MeasureKey[] = [
  'tokens',
  'toolCalls',
  'turns',
  'costUsd',
  'agentMs',
  'filesChanged',
  'linesAdded',
  'linesRemoved',
]

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function clipCell(s: string, max = 200): string {
  const t = escapeCell(s)
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return ''
  const head = `| ${headers.map(escapeCell).join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map((c) => clipCell(c)).join(' | ')} |`).join('\n')
  return `${head}\n${sep}\n${body}`
}

function citeList(cites: AttemptRef[]): string {
  if (cites.length === 0) return ''
  return cites.map((c) => `[${c.id}](${c.href})`).join(', ')
}

function h(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`
}

/** `source:file#L12` → `file:12`, matching the CLI's Worth knowing line. */
const remarkLocation = (at: string) => at.replace(/^source:/, '').replace(/#L(\d+)$/, ':$1')

function formatRemark(r: { text: string; fix?: { at: string; edit: string } | null }): string {
  if (!r.fix?.at) return r.text
  return r.fix.edit
    ? `${r.text} Fix at ${remarkLocation(r.fix.at)}: ${r.fix.edit}.`
    : `${r.text} At ${remarkLocation(r.fix.at)}.`
}

function shapeLabel(shapes: EvalSection['shapes']): string {
  const map = {
    task: 'Task',
    ab: 'A/B',
    discoverability: 'Discoverability',
    regression: 'Regression',
  } as const
  return shapes.map((s) => map[s]).join(', ')
}

function headlineBold(primary: HeadlinePrimary): string {
  switch (primary.kind) {
    case 'pass-rate':
      return `**${primary.rate.text} ${PASS_RATE_OUTCOME_LABEL[primary.outcome]}**`
    case 'lift':
      return `**${primary.variant.label} vs ${primary.baseline.label}: ${primary.points.text} pass rate (${primary.variantRate.text} vs ${primary.baselineRate.text})**`
    case 'tied-ceiling':
      return `**${primary.variant.label} vs ${primary.baseline.label}: tied at 100% pass rate, median ${MEASURE_LABEL[primary.lead.measure].toLowerCase()} ${primary.lead.delta.text} (${primary.lead.variant.text} vs ${primary.lead.baseline.text})**`
    case 'choice':
      return `**${primary.question}: ${primary.options.map((o) => `${o.label} ${o.count}`).join(', ')}**`
    case 'measure':
      return `**Median ${primary.label}: ${primary.spread.median.text}**`
    case 'judge':
      return `**${primary.label}: median ${primary.spread.median.text} on ${primary.scale[0]} to ${primary.scale[1]}**`
    case 'text':
      return `**${primary.question}**`
    case 'regression': {
      const parts = [
        primary.worse ? `${primary.worse} worse` : null,
        primary.fixed ? `${primary.fixed} fixed` : null,
      ].filter(Boolean)
      const counts = parts.length ? parts.join(', ') : 'no gated flips'
      if (!primary.lead) return `**${counts}**`
      return `**${counts}: ${primary.lead.signal}, ${primary.lead.prior} to ${primary.lead.current}**`
    }
  }
}

function headerLine(header: RunHeader): string {
  const { tally } = header
  const parts: string[] = []
  if (header.status !== 'complete') {
    parts.push(`Run stopped early (${header.status}).`)
  }
  if (tally.counted > 0) {
    parts.push(`${tally.passed} of ${tally.counted} counted attempts passed`)
  } else {
    parts.push(`${tally.counted} counted attempts`)
  }
  if (tally.reclassified > 0) {
    parts[parts.length - 1] += `, ${tally.reclassified} reclassified as infra error`
  }
  if (tally.infraError > tally.reclassified) {
    parts[parts.length - 1] += `, ${tally.infraError} infra errors`
  }
  parts[parts.length - 1] += '.'
  parts.push(`${header.wall.text} wall time.`)
  if (header.tokens) {
    parts.push(`${header.tokens.total.text} tokens (${header.tokens.cacheRead.text} cache reads).`)
  }
  if (header.cost) {
    const basis =
      header.cost.basis === 'estimated'
        ? ' (est.)'
        : header.cost.basis === 'mixed'
          ? ' (mixed)'
          : ''
    const bits = [
      header.cost.agent ? `agent ${header.cost.agent.text}` : null,
      header.cost.judge ? `judge ${header.cost.judge.text}` : null,
    ].filter(Boolean)
    if (bits.length) {
      parts.push(`${bits.join(', ')}${basis}.`)
    } else if (header.cost.total) {
      parts.push(`total ${header.cost.total.text}${basis}.`)
    } else {
      parts.push('No USD cost recorded.')
    }
  } else {
    parts.push('No USD cost recorded.')
  }
  if (header.git) {
    const dirty = header.git.dirty ? ' (dirty)' : ''
    const repo = header.git.repo ? `${header.git.repo}@` : ''
    parts.push(`${repo}${header.git.sha.slice(0, 7)}${dirty}.`)
  }
  return parts.join(' ')
}

function renderHeadline(headline: EvalHeadline, blockLevel: number): string[] {
  const lines: string[] = []
  if (headline.kicker) lines.push(headline.kicker, '')
  lines.push(headlineBold(headline.primary))
  if (headline.primary.kind === 'text' && headline.primary.lead) {
    const q = headline.primary.lead
    lines.push('')
    if (headline.primary.leadRole === 'representative') {
      lines.push(`Showing 1 of ${headline.primary.answered.k} answers as representative.`, '')
    }
    lines.push(`> ${clipCell(q.text, 400)} ([${q.attempt.id}, ${q.harness}](${q.attempt.href}))`)
  }
  lines.push('')
  lines.push(headline.foot)
  void blockLevel
  return lines
}

function measureCells(row: BreakdownRow | ArmRow): string[] {
  const measures =
    'measures' in row
      ? (row as BreakdownRow).measures
      : Object.fromEntries(
          MEASURE_ORDER.map((k) => {
            const m = (row as ArmRow).measures[k]
            return [k, m?.value ?? null] as const
          }),
        )
  return MEASURE_ORDER.map((k) => {
    if ('lift' in row) {
      const m = (row as ArmRow).measures[k]
      if (!m?.value) return 'not reported'
      const base = medianWithDelta(m.value.median.text, m.delta)
      if (m.lower) return `${base}, ${m.lower.text} harnesses lower`
      return base
    }
    const s = (measures as BreakdownRow['measures'])[k]
    return s ? s.median.text : 'not reported'
  })
}

function assertionTable(columns: string[], rows: AssertionRow[]): string {
  const headers = ['Assertion', 'Matcher', ...columns, 'Total']
  const body = rows.map((r) => [
    r.label,
    r.matcher,
    ...columns.map((c) => r.cells[c]?.text ?? 'n/a'),
    r.total.text,
  ])
  return table(headers, body)
}

function taskMarkdown(primary: TaskResults, blockLevel: number): string[] {
  const lines: string[] = []
  if (primary.assertions.length) {
    lines.push(h(blockLevel, 'Assertions'), '')
    lines.push(assertionTable(primary.columns, primary.assertions), '')
  }
  if (primary.breakdown.length) {
    const axisTitle =
      primary.axes.length === 1 && primary.axes[0] === 'harness'
        ? 'By coding harness'
        : `By ${primary.axes.join(' / ')}`
    lines.push(h(blockLevel, axisTitle), '')
    const headers = [...primary.axes, 'Pass rate', ...MEASURE_ORDER.map((k) => MEASURE_LABEL[k])]
    const rows = primary.breakdown.map((r) => [
      ...r.keys,
      r.rate?.text ?? 'n/a',
      ...measureCells(r),
    ])
    if (primary.median) {
      rows.push([
        ...primary.median.keys.map(() => '**Median**'),
        primary.median.rate?.text ?? 'n/a',
        ...measureCells(primary.median),
      ])
    }
    lines.push(table(headers, rows), '')
  }
  return lines
}

function comparisonMarkdown(primary: VariantComparison, blockLevel: number): string[] {
  const lines: string[] = []
  lines.push(h(blockLevel, 'Baseline vs. variants'), '')
  if (primary.arms.length) {
    lines.push(
      primary.arms
        .map((a) => `- **${a.label}** (\`${a.id}\`): ${a.role}${a.change ? `: ${a.change}` : ''}`)
        .join('\n'),
      '',
    )
  }
  if (primary.uniformLead) {
    lines.push(primary.uniformLead, '')
  }
  if (primary.summary.length) {
    const headers = [
      'Arm',
      'Pass rate',
      'Lift',
      'Pass-rate verdict',
      ...MEASURE_ORDER.map((k) => MEASURE_LABEL[k]),
    ]
    const rows = primary.summary.map((r) => [
      r.arm,
      r.rate.text,
      r.lift?.text ?? 'n/a',
      verdictLabel(r.verdict),
      ...measureCells(r),
    ])
    lines.push(table(headers, rows), '')
  }
  if (primary.assertionsByArm.length) {
    lines.push(h(blockLevel, 'Assertions by arm'), '')
    const cols = primary.arms.map((a) => a.label)
    lines.push(assertionTable(cols, primary.assertionsByArm), '')
  }
  if (primary.contrasts.length) {
    lines.push(h(blockLevel, 'Pairwise contrasts'), '')
    lines.push(
      table(
        ['From', 'To', 'Measure', 'Delta', 'Interval', 'Pass-rate verdict'],
        primary.contrasts.map((c: ContrastRow) => [
          c.from,
          c.to,
          contrastMeasureLabel(c.measure),
          c.delta.text,
          c.interval?.text ?? 'n/a',
          verdictLabel(c.verdict),
        ]),
      ),
      '',
    )
  }
  if (primary.effortByHarness.length) {
    lines.push(h(blockLevel, 'Effort by coding harness'), '')
    const headers = [
      'Coding harness',
      'Arm',
      'Pass rate',
      ...MEASURE_ORDER.map((k) => MEASURE_LABEL[k]),
    ]
    const rows = primary.effortByHarness.map((r) => [
      r.harness === 'Median' ? '**Median**' : r.harness,
      r.arm,
      r.rate.text,
      ...MEASURE_ORDER.map((k) => {
        const m = r.measures[k]
        if (!m?.value) return 'not reported'
        return medianWithDelta(m.value.median.text, m.delta)
      }),
    ])
    lines.push(table(headers, rows), '')
  }
  return lines
}

function regressionMarkdown(primary: RegressionChanges, blockLevel: number): string[] {
  const priorBits = [
    primary.prior.startedAt.slice(0, 10),
    primary.prior.gitSha ? primary.prior.gitSha.slice(0, 7) : null,
    primary.prior.branch,
    primary.prior.runId,
  ].filter(Boolean)
  const lines: string[] = [h(blockLevel, `Changes since ${priorBits.join(', ')}`), '']
  lines.push(`Prior run by ${primary.prior.author} on ${primary.prior.startedAt.slice(0, 10)}.`, '')
  if (primary.whatChanged.length) {
    lines.push(h(blockLevel + 1, 'What changed'), '')
    for (const line of primary.whatChanged) lines.push(`- ${line}`)
    lines.push('')
  }
  if (primary.rows.length) {
    lines.push(
      table(
        ['Signal', 'Kind', 'Harness', 'Prior', 'Current', 'Delta', 'Status', 'Gate'],
        primary.rows.map((r) => [
          r.signal,
          r.kind,
          r.harness ?? 'n/a',
          r.prior,
          r.current,
          r.delta?.text ?? 'n/a',
          COMPARE_STATUS_LABEL[r.status],
          r.gate ? 'gate' : 'ungated',
        ]),
      ),
      '',
    )
  }
  if (primary.unchanged.length) {
    lines.push(`<details><summary>Unchanged (${primary.unchanged.length})</summary>`, '')
    lines.push(
      table(
        ['Signal', 'Kind', 'Prior', 'Current'],
        primary.unchanged.map((r) => [r.signal, r.kind, r.prior, r.current]),
      ),
      '',
      '</details>',
      '',
    )
  }
  return lines
}

function choicesMarkdown(choices: ChoiceBreakdown[], blockLevel: number): string[] {
  const lines: string[] = []
  for (const c of choices) {
    lines.push(h(blockLevel, `Choices: ${c.question}`), '')
    lines.push(
      c.options.map((o) => `${o.label} ${o.count}`).join(', ') +
        (c.noPick ? `; ${c.noPick} without a pick` : ''),
      '',
    )
    if (c.rows.length) {
      const optionLabels = c.options.map((o) => o.label)
      const showArm = c.rows.some((r) => r.arm !== null)
      const headers = [
        ...(showArm ? ['Arm'] : []),
        'Prompt',
        'Coding harness',
        ...optionLabels,
        'Attempts',
      ]
      lines.push(
        table(
          headers,
          c.rows.map((r) => [
            ...(showArm ? [r.arm ?? 'n/a'] : []),
            r.prompt ?? 'n/a',
            r.harness,
            ...optionLabels.map((o) => String(r.counts[o] ?? 0)),
            String(r.attempts),
          ]),
        ),
        '',
      )
    }
    if (c.passByPick.length) {
      lines.push(h(blockLevel + 1, 'Pass rate by pick'), '')
      lines.push(
        table(
          ['Pick', 'Pass rate', 'n'],
          c.passByPick.map((p) => [p.option, p.rate.text, String(p.rate.n)]),
        ),
        '',
      )
    }
  }
  return lines
}

function discoveryMarkdown(rows: DiscoveryRate[], blockLevel: number): string[] {
  const lines: string[] = []
  for (const d of rows) {
    lines.push(h(blockLevel, `Discovery: ${d.what}`), '')
    lines.push(`${d.found.text} found.`, '')
    if (d.rows.length) {
      lines.push(
        table(
          ['Coding harness', 'Found'],
          d.rows.map((r) => [r.keys.join(' / '), r.found.text]),
        ),
        '',
      )
    }
    if (d.sources.length) {
      lines.push(
        table(
          ['Source', 'Count'],
          d.sources.map((s) => [DISCOVERY_SOURCE_LABEL[s.source], String(s.count)]),
        ),
        '',
      )
    }
  }
  return lines
}

function judgmentsMarkdown(j: JudgmentBreakdown, blockLevel: number): string[] {
  const lines: string[] = []
  if (j.scores.length) {
    lines.push(h(blockLevel, 'Judgments'), '')
    const showAt = j.scores.some((s) => s.atOrAbove !== null)
    const headers = [
      'Label',
      'Question',
      'Threshold',
      'Keys',
      'Median',
      ...(showAt ? ['At or above'] : []),
    ]
    lines.push(
      table(
        headers,
        j.scores.map((s) => [
          s.label,
          s.question,
          s.threshold === null ? 'diagnostic' : String(s.threshold),
          s.keys.join(' / ') || 'n/a',
          s.spread.median.text,
          ...(showAt ? [s.atOrAbove?.text ?? 'n/a'] : []),
        ]),
      ),
      '',
    )
  }
  if (j.pairwise.length) {
    lines.push(h(blockLevel, 'Pairwise review'), '')
    lines.push(
      table(
        ['Question', 'Cut', 'A', 'B', 'A wins', 'B wins', 'Ties', 'Pairs'],
        j.pairwise.map((p) => [
          p.question,
          p.cut,
          p.a,
          p.b,
          String(p.aWins),
          String(p.bWins),
          String(p.ties),
          String(p.pairs),
        ]),
      ),
      '',
    )
    const withReasons = j.pairwise.flatMap((p) =>
      p.reasons.map((r) => ({ question: p.question, ...r })),
    )
    if (withReasons.length) {
      lines.push(h(blockLevel + 1, 'Pairwise reasons'), '')
      for (const r of withReasons) {
        const cites = citeList(r.cites)
        lines.push(`- ${clipCell(r.text, 300)}${cites ? ` (${cites})` : ''}`)
      }
      lines.push('')
    }
  }
  return lines
}

function qualitativeMarkdown(rows: QualitativeAnswers[], blockLevel: number): string[] {
  const lines: string[] = []
  for (const q of rows) {
    lines.push(h(blockLevel, `Answers: ${q.question}`), '')
    lines.push(`${q.answered.text} answered.`, '')
    const shown = q.entries.slice(0, 12)
    for (const e of shown) {
      lines.push(`- ${clipCell(e.text, 240)} ([${e.attempt.id}, ${e.harness}](${e.attempt.href}))`)
    }
    if (q.entries.length > shown.length) {
      lines.push(`- …and ${q.entries.length - shown.length} more.`)
    }
    lines.push('')
  }
  return lines
}

function capturesMarkdown(gallery: CaptureGallery, blockLevel: number): string[] {
  const lines: string[] = [h(blockLevel, 'Captures'), '']
  const showArm = gallery.rows.some((r) => r.arm !== null)
  const showNotes = gallery.rows.some((r) => r.shots.some((s) => s.meta))
  const rows: string[][] = []
  for (const r of gallery.rows) {
    for (const shot of r.shots) {
      const link = shot.href ? `[${shot.name}](${shot.href})` : `${shot.name} (not kept)`
      rows.push([
        r.harness,
        ...(showArm ? [r.arm ?? 'n/a'] : []),
        r.case ?? 'n/a',
        link,
        shot.status === null ? 'n/a' : String(shot.status),
        shot.pageErrors === null ? 'n/a' : String(shot.pageErrors),
        ...(showNotes ? [shot.meta ?? 'n/a'] : []),
        shot.attempt.id,
      ])
    }
  }
  lines.push(
    table(
      [
        'Coding harness',
        ...(showArm ? ['Arm'] : []),
        'Case',
        'Capture',
        'HTTP',
        'Page errors',
        ...(showNotes ? ['Notes'] : []),
        'Attempt',
      ],
      rows,
    ),
    '',
  )
  return lines
}

function failuresMarkdown(f: FailureClusters, blockLevel: number): string[] {
  const lines: string[] = [h(blockLevel, 'Failures and caveats'), '']
  if (f.clusters.length) {
    lines.push(
      table(
        ['Kind', 'Label', 'At', 'Count', 'Attempts'],
        f.clusters.map((c) => [c.kind, c.label, c.at ?? 'n/a', c.count.text, citeList(c.attempts)]),
      ),
      '',
    )
  }
  if (f.remarks.length) {
    lines.push(h(blockLevel + 1, 'Worth knowing'), '')
    for (const r of f.remarks) {
      lines.push(`- (${r.severity}) ${formatRemark(r)}`)
    }
    lines.push('')
  }
  return lines
}

function evalSectionMarkdown(section: EvalSection, single: boolean): string {
  const blockLevel = single ? 2 : 3
  const lines: string[] = []
  if (!single) {
    lines.push(h(2, section.name), '')
  }
  lines.push(`\`${section.file}\`. ${shapeLabel(section.shapes)}. ${section.design}.`, '')
  lines.push(...renderHeadline(section.headline, blockLevel), '')
  if (section.insights.length) {
    lines.push(h(blockLevel, 'Key findings'), '')
    for (const claim of section.insights) {
      const cites = citeList(claim.cites)
      lines.push(`- ${claim.text}${cites ? ` ${cites}` : ''}`)
    }
    lines.push('')
  }
  if (section.primary?.kind === 'task') lines.push(...taskMarkdown(section.primary, blockLevel))
  if (section.primary?.kind === 'comparison') {
    lines.push(...comparisonMarkdown(section.primary, blockLevel))
  }
  if (section.primary?.kind === 'regression') {
    lines.push(...regressionMarkdown(section.primary, blockLevel))
  }
  lines.push(...choicesMarkdown(section.choices, blockLevel))
  lines.push(...discoveryMarkdown(section.discovery, blockLevel))
  if (section.judgments) lines.push(...judgmentsMarkdown(section.judgments, blockLevel))
  lines.push(...qualitativeMarkdown(section.qualitative, blockLevel))
  if (section.captures) lines.push(...capturesMarkdown(section.captures, blockLevel))
  if (section.failures) lines.push(...failuresMarkdown(section.failures, blockLevel))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

export const blockMarkdown: BlockMarkdown = {
  runHeader(header, _single) {
    void _single
    return [`# ${header.title}`, '', headerLine(header), ''].join('\n')
  },
  integrity(issues) {
    if (issues.length === 0) return ''
    const caution = issues.some((i) => i.severity === 'error')
    const lines = [
      `> [!${caution ? 'CAUTION' : 'WARNING'}]`,
      '> Integrity: read these before the results.',
      '>',
      ...issues.map((i) => {
        const cites = citeList(i.cites)
        return `> - ${i.text}${cites ? ` ${cites}` : ''}`
      }),
      '',
    ]
    return lines.join('\n')
  },
  rollup(rollup) {
    const lines: string[] = [h(2, 'Summary'), '']
    if (rollup.lead) {
      lines.push(rollup.lead.text, '')
    }
    if (rollup.rows.length) {
      lines.push(
        table(
          ['Evaluation', 'Shape / arms', 'Primary result', 'Effort'],
          rollup.rows.map((r) => [
            `[${r.name}](#${r.anchor})`,
            `${r.shapes.join(', ')}; ${r.design}`,
            r.primary,
            r.medianTokens.text,
          ]),
        ),
        '',
      )
    }
    if (rollup.findings.length) {
      lines.push(h(3, 'Key findings across evaluations'), '')
      for (const f of rollup.findings) {
        lines.push(`- ${f.text}${citeList(f.cites) ? ` ${citeList(f.cites)}` : ''}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  },
  roster(rows) {
    if (rows.length === 0) return ''
    return [
      h(2, 'Coding harnesses'),
      '',
      table(
        ['Coding harness', 'Model', 'Effort', 'Served models', 'Gateway', 'Attempts'],
        rows.map((r: RosterRow) => [
          r.harness,
          r.model ?? 'n/a',
          r.effort ?? 'n/a',
          r.servedModels.join(', ') || 'n/a',
          r.gateway ?? 'n/a',
          String(r.attempts),
        ]),
      ),
      '',
    ].join('\n')
  },
  evalSection(section, single) {
    return evalSectionMarkdown(section, single)
  },
  actions(claims) {
    if (claims.length === 0) return ''
    const lines = [h(2, 'Recommended actions'), '']
    for (const c of claims) {
      lines.push(`- ${c.text}${citeList(c.cites) ? ` ${citeList(c.cites)}` : ''}`)
    }
    lines.push('')
    return lines.join('\n')
  },
  provenance(state: ProvenanceState) {
    const lines = [h(2, 'State'), '']
    const rows = state.rows.map((r) => [r.field, r.value])
    rows.push(['Artifacts', state.artifacts])
    rows.push(['Record', `[${state.record.split('/').pop()}](${state.record})`])
    if (state.context.count > 0) {
      rows.push(['Context', `${state.context.count} files`])
    }
    lines.push(table(['Field', 'Value'], rows), '')
    if (state.context.count > 5) {
      lines.push(
        `<details><summary>All ${state.context.count} context files</summary>`,
        '',
        table(
          ['Path', 'sha256'],
          state.context.files.map((f) => [f.path, f.sha256.replace(/^sha256:/, '').slice(0, 12)]),
        ),
        '',
        '</details>',
        '',
      )
    } else if (state.context.count > 0) {
      lines.push(
        table(
          ['Path', 'sha256'],
          state.context.files.map((f) => [f.path, f.sha256.replace(/^sha256:/, '').slice(0, 12)]),
        ),
        '',
      )
    }
    for (const w of state.warnings) lines.push(`> **Warning:** ${w}`, '')
    return lines.join('\n')
  },
  attemptIndex(rows: AttemptIndexRow[], _single) {
    void _single
    if (rows.length === 0) return ''
    const lines = [h(2, 'Attempt index'), '']
    lines.push(
      table(
        [
          'ID',
          'Eval',
          'Coding harness',
          'Arm / Case',
          'Outcome',
          'Tokens',
          'Agent time',
          'Tools',
          'Diff',
          'Evidence',
        ],
        rows.map((r) => {
          const evidence = [
            r.links.transcript ? `[transcript](${r.links.transcript})` : null,
            r.links.diff ? `[diff](${r.links.diff})` : null,
            ...r.links.captures.map((c) => `[${c.name}](${c.href})`),
            ...r.links.questions.map((q, i) => `[q${i + 1}](${q})`),
          ]
            .filter(Boolean)
            .join(', ')
          return [
            `<a id="${attemptAnchorId(r.key)}"></a>${r.id}`,
            r.evalId,
            r.harness,
            [r.arm, r.case].filter(Boolean).join(' / ') || 'n/a',
            r.reclassified ? `${r.outcome} (reclassified)` : r.outcome,
            r.tokens.text,
            r.agentMs.text,
            r.toolCalls.text,
            r.diff?.text ?? 'not recorded',
            evidence || 'n/a',
          ]
        }),
      ),
      '',
    )
    return lines.join('\n')
  },
}

/** Render a `RunReport` to standalone GFM. */
export function runReportMarkdown(report: RunReport): string {
  const parts: string[] = []
  parts.push(`# ${report.header.title}`)
  parts.push('')
  parts.push(headerLine(report.header))
  parts.push('')
  const meta = `Run \`${report.runId}\` by ${report.header.author}, ${report.header.startedAt.slice(0, 10)}, reeval ${report.header.reeval}${report.header.profile ? `, profile \`${report.header.profile}\`` : ''}, ${
    report.header.runsPerCell === null
      ? 'varying runs per cell'
      : `${report.header.runsPerCell} run${report.header.runsPerCell === 1 ? '' : 's'} per cell`
  }.`
  parts.push(meta)
  parts.push('')
  if (report.integrity.length) parts.push(blockMarkdown.integrity(report.integrity))
  if (report.rollup) parts.push(blockMarkdown.rollup(report.rollup))
  if (report.roster.length) parts.push(blockMarkdown.roster(report.roster))
  for (const section of report.evals) {
    parts.push(blockMarkdown.evalSection(section, report.single))
    parts.push('')
  }
  if (report.actions.length) parts.push(blockMarkdown.actions(report.actions))
  parts.push(blockMarkdown.provenance(report.provenance))
  parts.push(blockMarkdown.attemptIndex(report.attempts, report.single))
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}
