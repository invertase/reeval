import type { AnalysisClaim, AnalysisDoc } from '../view/analysis.ts'

const cite = (cs: string[]) => (cs.length ? ` ${cs.map((c) => `[${c}]`).join(' ')}` : '')
const note = (c: AnalysisClaim) =>
  [
    c.confidence === 'high' ? '' : `${c.confidence} confidence`,
    c.unverifiedNumbers?.length ? `unverified: ${c.unverifiedNumbers.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')

export function footer(doc: AnalysisDoc): string {
  const v = doc.validation
  const tokens =
    doc.usage.inputTokens !== null
      ? `${doc.usage.inputTokens} in / ${doc.usage.outputTokens ?? '?'} out tokens · `
      : ''
  return `${doc.resolvedModel ?? doc.model} · ${doc.promptVersion} · digest v${doc.inputs.digestVersion} · ${tokens}${Math.round(doc.latencyMs / 1000)}s · ${v.citations} citations checked, ${v.invalid.length} invalid, ${v.dropped} dropped · ${v.commands} commands checked, ${v.invalidCommands.length} rejected`
}

/** The analysis as Markdown (`--md`, and the `.md` twin of a saved analysis). */
export function renderMarkdown(doc: AnalysisDoc): string {
  const a = doc.analysis
  const md = [
    `## reeval analysis · ${doc.scope.head}${doc.scope.base ? ` vs ${doc.scope.base}` : ''}`,
    '',
    `**TL;DR** (${a.confidence.overall}). ${a.tldr}`,
    '',
  ]
  for (const [title, items] of [
    ['What happened', a.whatHappened],
    ['Results', a.results],
    ['Why', a.why],
  ] as const) {
    if (!items.length) continue
    md.push(`### ${title}`, '')
    for (const c of items) md.push(`- ${c.text}${cite(c.cites)}${note(c) ? ` *(${note(c)})*` : ''}`)
    md.push('')
  }
  if (a.anomalies.length) {
    md.push('### Anomalies', '')
    for (const x of a.anomalies) md.push(`- **${x.kind}**: ${x.text}${cite(x.cites)}`)
    md.push('')
  }
  md.push('### Suggested actions', '')
  if (!a.actions.length) md.push('None: nothing here is worth acting on.')
  a.actions.forEach((x, i) => {
    md.push(
      `${i + 1}. **${x.title}** (${x.kind} · impact ${x.impact} · effort ${x.effort})  `,
      `   Target: \`${x.target}\`. ${x.change}  `,
      `   Expect: ${x.expectedEffect}  `,
      x.verify
        ? `   Verify: \`${x.verify}\`${cite(x.cites)}`
        : `   Verify: none (the suggested command isn't reeval's CLI: ${x.verifyProblem ?? 'unknown'})${cite(x.cites)}`,
    )
  })
  md.push(
    '',
    `**Confidence: ${a.confidence.overall}.** ${a.confidence.why}`,
    '',
    `<sub>${footer(doc)}</sub>`,
    '',
  )
  return md.join('\n')
}

/** The analysis for a terminal: the same sections, plain. */
export function renderText(doc: AnalysisDoc): string {
  const a = doc.analysis
  const lines = [
    `analysis ${doc.scope.head}${doc.scope.base ? ` vs ${doc.scope.base}` : ''}`,
    '',
    `TL;DR (${a.confidence.overall})  ${a.tldr}`,
  ]
  for (const [title, items] of [
    ['What happened', a.whatHappened],
    ['Results', a.results],
    ['Why', a.why],
  ] as const) {
    if (!items.length) continue
    lines.push('', title)
    for (const c of items)
      lines.push(`  - ${c.text}${cite(c.cites)}${note(c) ? ` (${note(c)})` : ''}`)
  }
  if (a.anomalies.length) {
    lines.push('', 'Anomalies')
    for (const x of a.anomalies) lines.push(`  - ${x.kind}: ${x.text}${cite(x.cites)}`)
  }
  lines.push('', 'Suggested actions')
  if (!a.actions.length) lines.push('  none: nothing here is worth acting on')
  a.actions.forEach((x, i) => {
    lines.push(
      `  ${i + 1}. ${x.title} (${x.kind} · impact ${x.impact} · effort ${x.effort})${cite(x.cites)}`,
      `     target: ${x.target}. ${x.change}`,
      `     expect: ${x.expectedEffect}`,
      x.verify
        ? `     verify: ${x.verify}`
        : `     verify: none (${x.verifyProblem ?? 'rejected'})`,
    )
  })
  lines.push('', `Confidence: ${a.confidence.overall}. ${a.confidence.why}`, '', footer(doc))
  return lines.join('\n')
}
