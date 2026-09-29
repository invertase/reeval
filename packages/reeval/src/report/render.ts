// `reeval report`'s bundle as text: the terminal summary, report.md, and the shorter issue body.
import type { DoctorReport } from '../doctor.ts'
import type { ReportBundle } from './types.ts'

const isDoctor = (value: unknown): value is DoctorReport =>
  !!value && typeof value === 'object' && Array.isArray((value as DoctorReport).checks)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function versionsLine(b: ReportBundle): string {
  const pm = b.packageManager
  return [
    `reeval ${b.es}`,
    `Node ${b.node}`,
    b.npm ? `npm ${b.npm}` : 'no npm',
    ...(pm ? [`${pm.name}${pm.version ? ` ${pm.version}` : ''}`] : []),
    `${b.os.platform} ${b.os.release} ${b.os.arch}`,
    ...(b.ci ? ['CI'] : []),
    ...(b.agent ? [`agent ${b.agent}`] : []),
  ].join(' · ')
}

export function commandLine(b: ReportBundle): string | null {
  const i = b.invocation
  if (!i) return null
  return `reeval ${i.argv.join(' ')} → exit ${i.exitCode}${i.runId ? ` (run ${i.runId})` : ''}, ${i.at}`
}

/** The error the report is about: the last command's, else the run's first failure. */
export function headline(b: ReportBundle): string | null {
  const error = b.invocation?.error
  if (error) return `${error.name}: ${error.message}`.split('\n')[0] as string
  const unhandled = b.invocation?.unhandledErrors[0]
  if (unhandled) return unhandled.split('\n')[0] as string
  const failure = b.run?.failures.find((f) => f.outcome === 'infra_error') ?? b.run?.failures[0]
  if (failure?.error)
    return `${failure.error.kind}: ${failure.error.message}`.split('\n')[0] as string
  return null
}

export function runLine(b: ReportBundle): string | null {
  if (!b.run) return b.runError ? `none (${b.runError})` : null
  const s = b.run.summary
  const parts = [
    plural(s.attempts ?? 0, 'attempt'),
    `${s.pass ?? 0} pass`,
    ...(s.fail ? [`${s.fail} fail`] : []),
    ...(s.infraError ? [plural(s.infraError, 'infra error')] : []),
    ...(s.skipped ? [`${s.skipped} skipped`] : []),
  ]
  return `${b.run.runId}: ${b.run.outcome}, ${parts.join(', ')}`
}

export function doctorLine(b: ReportBundle): string {
  if (!isDoctor(b.doctor)) return `didn't run (${(b.doctor as { error?: string })?.error ?? '?'})`
  const d = b.doctor
  const failing = [...new Set(d.checks.filter((c) => c.status === 'fail').map((c) => c.id))]
  return `${plural(d.problems, 'problem')}${failing.length ? ` (${failing.join(', ')})` : ''}, ${plural(d.warnings, 'warning')}`
}

export function configLine(b: ReportBundle): string {
  const c = b.config
  if (!c) return `not loaded (${b.configError ?? '?'})`
  return [
    `${c.file}: keys ${c.optionKeys.join(', ') || 'none'}`,
    `harness ${c.harnesses.join(', ')}`,
    `sandbox ${c.sandboxes.join(', ')}`,
    c.profiles.length ? `profiles ${c.profiles.map((p) => p.name).join(', ')}` : 'no profiles',
  ].join('; ')
}

export function redactionLine(b: ReportBundle): string {
  const paths = [
    'home → ~',
    ...(b.redaction.paths.includes('<project>') ? ['project → <project>'] : []),
  ]
  const { masked, upstream } = b.redaction
  const already =
    upstream && upstream < masked
      ? `, ${upstream} of them already by reeval's records and logs`
      : upstream
        ? ", all already by reeval's records and logs"
        : ''
  return `${plural(masked, 'secret value')} masked${already}; ${paths.join(', ')}`
}

/** The terminal summary, one labelled line each. */
export function summaryLines(b: ReportBundle, attached: number): string[] {
  const rows: Array<[string, string | null]> = [
    ['versions', versionsLine(b)],
    ['command', commandLine(b) ?? 'none logged in this project'],
    ['error', headline(b)],
    ['run', runLine(b)],
    [
      'failing',
      b.run?.failures.length
        ? b.run.failures.map((f) => `${f.key}${f.error ? ` (${f.error.kind})` : ''}`).join('; ') +
          (b.run.moreFailures ? ` and ${b.run.moreFailures} more` : '')
        : null,
    ],
    ['doctor', doctorLine(b)],
    ['config', configLine(b)],
    ['logs', attached ? `${plural(attached, 'debug file')} attached` : null],
    ['redacted', redactionLine(b)],
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  return rows.flatMap(([k, v]) => (v ? [`${k.padEnd(width)}  ${v}`] : []))
}

const fence = (lang: string, lines: string[]) => ['', `\`\`\`${lang}`, ...lines, '```']

function stackLines(b: ReportBundle, max = Number.POSITIVE_INFINITY): string[] {
  const error = b.invocation?.error
  if (!error) return []
  const lines = (error.stack ?? `${error.name}: ${error.message}`).split('\n')
  return lines.length > max ? [...lines.slice(0, max), '…'] : lines
}

/** report.md: everything in the bundle, for a person to read and attach. */
export function renderMarkdown(b: ReportBundle, attachedFiles: string[]): string {
  const out = [
    '# reeval report',
    '',
    `Collected by \`reeval report\` at ${b.createdAt}. ${redactionLine(b)}. Review it before you share it.`,
    '',
    '## Environment',
    '',
    '| | |',
    '|---|---|',
    `| reeval | ${b.es} |`,
    `| Node | ${b.node} |`,
    `| npm | ${b.npm ?? 'not found'} |`,
    `| Package manager | ${b.packageManager ? `${b.packageManager.name} ${b.packageManager.version ?? ''} (from ${b.packageManager.from})` : 'unknown'} |`,
    `| OS | ${b.os.platform} ${b.os.release} ${b.os.arch} |`,
    `| CI | ${b.ci ? 'yes' : 'no'} |`,
    `| Coding agent | ${b.agent ?? 'none'} |`,
    `| Variables set | ${b.env.join(', ') || 'none'} |`,
    '',
    '## Last command',
    '',
    b.invocation
      ? `\`reeval ${b.invocation.argv.join(' ')}\` exited ${b.invocation.exitCode} after ${b.invocation.durationMs} ms, at ${b.invocation.at}${b.invocation.runId ? `, run \`${b.invocation.runId}\`` : ''}.`
      : 'No `reeval` command is logged in this project (`.reeval/cli.jsonl`).',
  ]
  if (b.invocation?.error) out.push(...fence('text', stackLines(b)))
  for (const e of b.invocation?.unhandledErrors ?? []) out.push(...fence('text', e.split('\n')))
  out.push('', '## Run', '')
  if (!b.run) out.push(b.runError ? `No run: ${b.runError}` : 'No run.')
  else {
    out.push(`${runLine(b)}, status ${b.run.status}.`)
    if (b.run.moreFailures)
      out.push('', `${b.run.moreFailures} more failing attempts aren't shown.`)
    for (const f of b.run.failures) {
      out.push('', `### ${f.key}`, '', `Outcome ${f.outcome}.`)
      if (f.error) out.push(...fence('text', [`${f.error.kind}: ${f.error.message}`]))
      for (const t of f.turnErrors) out.push(...fence('text', [`turn: ${t}`]))
      if (f.debugLog.length) out.push('', 'debug.log, last lines:', ...fence('text', f.debugLog))
      if (f.requests.length) {
        out.push('', 'Refused or failed gateway requests:', ...fence('json', f.requests))
      }
      if (f.trace.length) out.push('', 'trace.ndjson, last lines:', ...fence('json', f.trace))
    }
    out.push('', '### Sandbox and images', ...fence('json', [JSON.stringify(b.run.stack, null, 2)]))
  }
  out.push('', '## reeval doctor')
  if (isDoctor(b.doctor)) {
    out.push(
      ...fence(
        'text',
        b.doctor.checks.map(
          (c) =>
            `${c.status.padEnd(4)} ${c.id.padEnd(9)} ${c.summary}${c.fix ? ` (fix: ${c.fix})` : ''}`,
        ),
      ),
    )
  } else out.push('', doctorLine(b))
  out.push('', '## Config', '', configLine(b))
  if (b.config?.profiles.length) {
    out.push('', '| Profile | Keys | Defaults |', '|---|---|---|')
    for (const p of b.config.profiles) {
      out.push(`| ${p.name} | ${p.keys.join(', ')} | ${p.defaults.join(', ') || '-'} |`)
    }
  }
  if (attachedFiles.length) {
    out.push(
      '',
      '## Attached logs',
      '',
      'In `report-logs.tar.gz`, by path under `.reeval/debug`:',
      '',
    )
    out.push(...attachedFiles.map((f) => `- \`${f}\``))
  }
  return `${out.join('\n')}\n`
}

/** The issue's body: what a maintainer reads first; report.md has the rest. */
export function renderIssueBody(b: ReportBundle, reportDir: string | null): string {
  const out = [
    `**Environment:** ${versionsLine(b)}`,
    '',
    `**Command:** ${b.invocation ? `\`reeval ${b.invocation.argv.join(' ')}\` → exit ${b.invocation.exitCode}` : 'none logged'}`,
  ]
  const stack = stackLines(b, 25)
  if (stack.length) out.push(...fence('text', stack))
  const run = runLine(b)
  if (run) out.push('', `**Run:** ${run}`)
  for (const f of b.run?.failures ?? []) {
    out.push(
      `- \`${f.key}\`: ${f.error ? `${f.error.kind}: ${f.error.message.split('\n')[0]}` : f.outcome}`,
    )
  }
  out.push('', `**reeval doctor:** ${doctorLine(b)}`)
  if (isDoctor(b.doctor)) {
    for (const c of b.doctor.checks.filter((c) => c.status === 'fail' || c.status === 'warn')) {
      out.push(`- ${c.status} ${c.id}: ${c.summary}`)
    }
  }
  out.push('', `**Config:** ${configLine(b)}`, '', `_${redactionLine(b)}._`)
  out.push(
    '',
    reportDir
      ? `The full report is in \`${reportDir}\`: attach \`report.md\` (and \`report-logs.tar.gz\`, if it's there) to this issue.`
      : 'Run `reeval report --out <dir>` and attach `report.md` to this issue.',
  )
  return out.join('\n')
}

/** The issue's title, from the error. */
export function issueTitle(b: ReportBundle): string {
  const command = b.invocation?.command ? `reeval ${b.invocation.command}` : 'reeval'
  const what = headline(b) ?? (b.run ? `run ended ${b.run.outcome}` : 'bug report')
  const title = `${command}: ${what}`
  return title.length > 100 ? `${title.slice(0, 99)}…` : title
}
