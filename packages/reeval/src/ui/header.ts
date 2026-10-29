// What `reeval run` prints before its logs on a color terminal (`OutputOptions.rich`): the plan as
// a block of facts under a title, its warnings and hints wrapped to the terminal's width with a
// hanging indent, and one line per step until the attempts start. Anywhere else the plan is one
// greppable line, and these never print.
import { formatDuration, plural } from '../text.ts'
import { type Colors, type Paint, stripAnsi } from './colors.ts'
import type { ReevalEvent, RunHeader } from './events.ts'
import { tailLines } from './format.ts'
import type { OutputOptions } from './mode.ts'

/** `  ➜  `, `  ⚠  `: the glyph column every line of the block starts with. */
const GLYPH = 5
/** `Est. Time: `, the longest key. */
const KEY = 11
/** `Warning: `, the longer note label. */
const LABEL = 9

/**
 * `text` broken at spaces into lines of at most `width` columns, not counting color codes; a
 * longer word keeps a line. A `·` stays with the word before it, so no line starts with one.
 */
function wrap(text: string, width: number): string[] {
  const words: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word === '·' && words.length) words[words.length - 1] += ' ·'
    else words.push(word)
  }
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && stripAnsi(line).length + 1 + stripAnsi(word).length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  return line ? [...lines, line] : lines
}

const indent = (n: number) => ' '.repeat(n)

/** `REEVAL v0.16.1`, then the run's facts, one `➜ Key: value` line each. */
export function headerLines(c: Colors, h: RunHeader, width: number): string[] {
  // A terminal that draws bold in the bright colors would wash a 16-color title out on white.
  const name = `REEVAL v${h.version}`
  const title = c.bold(c.depth === 4 ? name : c.teal(name))
  const valueWidth = width - GLYPH - KEY
  const row = (key: string, value: string | string[]) => {
    const values = typeof value === 'string' ? [value] : value
    const joined = values.join(', ')
    // A list that doesn't fit on the line takes one line per item, under the first.
    const lines =
      values.length > 1 && joined.length > valueWidth ? values : wrap(joined, valueWidth)
    return lines.map((v, i) =>
      i === 0
        ? `  ${c.teal('➜')}  ${c.dim(`${key}:`)}${indent(KEY - key.length - 1)}${v}`
        : `${indent(GLYPH + KEY)}${v}`,
    )
  }
  const many = (one: string, n: number, many = `${one}s`) => (n === 1 ? one : many)
  const resumed = h.resumed ? c.dim(` (resumed, ${plural(h.resumed, 'attempt')} done)`) : ''
  const reason =
    h.profile && h.profile.reason !== '--profile' ? c.dim(` (${h.profile.reason})`) : ''
  return [
    h.dryRun ? `${title}  ${c.dim('dry run')}` : title,
    '',
    ...row('Run', `${h.runId}${resumed}`),
    ...(h.config ? row('Config', h.config) : []),
    ...(h.profile ? row('Profile', `${h.profile.name}${reason}`) : []),
    ...row(many('Harness', h.harnesses.length, 'Harnesses'), h.harnesses),
    ...row(many('Sandbox', h.sandboxes.length, 'Sandboxes'), h.sandboxes),
    ...(h.judges.length ? row(many('Judge', h.judges.length), h.judges) : []),
    ...row('Scope', scope(c, h)),
    ...row('Est. Time', estimate(c, h)),
    ...(h.record && !h.dryRun ? row('Record', h.record) : []),
  ]
}

function scope(c: Colors, h: RunHeader): string {
  const attempts =
    h.fewest < h.attempts ? `${h.fewest}–${h.attempts} attempts` : plural(h.attempts, 'attempt')
  const parts = [
    plural(h.files, 'eval file'),
    plural(h.evals, 'eval') + (h.skipped ? ` (${h.skipped} skipped)` : ''),
    plural(h.cells, 'cell'),
    attempts,
  ]
  const caps = [
    h.budget.attempts !== undefined
      ? `${h.budget.attempts} ${h.attempts <= h.budget.attempts ? c.green('✓') : c.red('✗')}`
      : '',
    h.budget.duration ?? '',
  ].filter(Boolean)
  return `${parts.join(' · ')}${caps.length ? ` (budget: ${caps.join(', ')})` : ''}`
}

function estimate(c: Colors, h: RunHeader): string {
  const serial = `~${formatDuration(h.estimateMs)} ${c.dim('(serial)')}`
  const parallel = Math.min(h.concurrency, h.attempts)
  if (parallel <= 1) return serial
  const at = `~${formatDuration(h.estimateMs / parallel)} ${c.dim(`(concurrency: ${h.concurrency})`)}`
  return `${at} · ${serial}`
}

/** `⚠  Warning: …` or `ℹ  Hint:    …`, wrapped under its first word. */
export function noteLines(
  c: Colors,
  kind: 'warning' | 'root' | 'hint',
  text: string,
  width: number,
): string[] {
  const [glyph, label, paint]: [string, string, Paint] =
    kind === 'hint' ? ['ℹ', 'Hint:', c.blue] : ['⚠', 'Warning:', kind === 'root' ? c.red : c.orange]
  // 16 colors have no orange or blue that reads on both a light and a dark theme (yellow fades on
  // white, blue on black): only the glyph is colored there, and the label is bold in the
  // terminal's own text color.
  const basic = { warning: c.yellow, hint: c.teal, root: c.red }[kind]
  const lead =
    c.depth === 4 && kind !== 'root'
      ? `${basic(glyph)}  ${c.bold(label)}`
      : c.bold(paint(`${glyph}  ${label}`))
  const at = GLYPH + LABEL
  return wrap(text, Math.max(20, width - at)).map((line, i) =>
    i === 0 ? `  ${lead}${indent(LABEL - label.length)}${line}` : `${indent(at)}${line}`,
  )
}

/** A step line, `◆  Preparing 1 sandbox (docker)...`, its text wrapped under itself. */
function stepLines(glyph: string, text: string, width: number): string[] {
  return wrap(text, Math.max(20, width - GLYPH)).map((line, i) =>
    i === 0 ? `  ${glyph}  ${line}` : `${indent(GLYPH)}${line}`,
  )
}

/** A run-level notice (a prepared workspace, the Ctrl-C one) as a step line. */
export function noticeLines(
  c: Colors,
  e: Extract<ReevalEvent, { type: 'notice' }>,
  width: number,
): string[] {
  const glyph = { info: c.dim('ℹ'), warn: c.orange('⚠'), error: c.red('✗') }[e.level]
  const lines = stepLines(glyph, e.text, width)
  return e.level === 'info' ? lines.map((l) => c.dim(l)) : lines
}

/** Preflight: which sandboxes it prepares, each one ready, and each failure. */
export function prepareStepLines(
  c: Colors,
  e: Extract<ReevalEvent, { type: 'prepare' }>,
  width: number,
  max: number,
): string[] {
  if (e.state === 'start') {
    const n = e.targets.length
    const names = e.targets.map((t) => t.label).join(', ')
    return stepLines(
      c.teal('◆'),
      `Preparing ${plural(n, 'sandbox', 'sandboxes')} (${names})...`,
      width,
    )
  }
  const { outcome } = e
  if (outcome.ok) {
    const took = outcome.ms >= 1000 ? ` ${c.dim(formatDuration(outcome.ms))}` : ''
    return [`  ${c.green('✓')}  ${outcome.target.label} ready${took}`]
  }
  const who = outcome.target.setBy.join(', ')
  return [
    `  ${c.red('✗')}  ${outcome.target.label} failed to prepare ${c.dim(`(set by ${who}; only its attempts fail)`)}`,
    ...tailLines(outcome.failure.message, max).map((l) => `${indent(GLYPH)}${c.orange(l)}`),
  ]
}

/** The last line before the attempts' own: how their logs will print. */
export function startLine(c: Colors, output: OutputOptions): string {
  const text =
    output.outputLogs === 'none'
      ? 'Running...'
      : output.outputLogs === 'errors-only'
        ? 'Running; logs print for failed attempts only...'
        : output.logOrder === 'stream'
          ? 'Streaming logs...'
          : "Running; each attempt's logs print as it ends..."
  return `  ${c.teal('◆')}  ${text}`
}
