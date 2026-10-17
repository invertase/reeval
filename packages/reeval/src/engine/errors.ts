// How an attempt's error prints: its message, the diff, and the stack with a code frame at the
// eval's own line, as Vitest's reporter printed them. Workers serialize errors with
// @vitest/utils (`serializeError`); this runs in the main process.
import { existsSync, readFileSync } from 'node:fs'
import { sep } from 'node:path'
import { inspect, stripVTControlCharacters } from 'node:util'
import type { ParsedStack } from '@vitest/utils'
import { truncateString } from '@vitest/utils/display'
import { lineSplitRE, positionToOffset } from '@vitest/utils/offset'
import { parseErrorStacktrace } from '@vitest/utils/source-map'
import { relativeFile } from '../ids.ts'

/** An error as a worker serialized it. */
export type SerializedError = {
  name?: string
  message?: string
  stack?: unknown
  diff?: string
  frame?: string
  codeFrame?: string
  cause?: unknown
  stacks?: ParsedStack[]
  [key: string]: unknown
}

const paint =
  (open: number, close = 39) =>
  (text: string) =>
    `\x1b[${open}m${text}\x1b[${close}m`
const red = paint(31)
const yellow = paint(33)
const cyan = paint(36)
const gray = paint(90)
const bold = paint(1, 22)
const dim = paint(2, 22)

const POINTER = '❯'

/** reeval's own directories; their frames are noise in an eval's stack. */
export const reevalFrames = (packageDir: string) => [
  `${packageDir}${packageDir.endsWith(sep) ? '' : sep}src${sep}`,
  `${packageDir}${packageDir.endsWith(sep) ? '' : sep}dist${sep}`,
]

/** A path as frames are compared: forward slashes (parsed frames say C:/… on Windows), any case there. */
export const comparable = (path: string, windows = process.platform === 'win32') => {
  const slashed = path.replaceAll('\\', '/')
  return windows ? slashed.toLowerCase() : slashed
}

/** Loaders and assertion libraries reeval runs eval files through; never the eval's own frames. */
const HIDDEN = ['/node_modules/jiti/', '/node_modules/@vitest/', '/node_modules/chai/']

export type FormatOptions = {
  root: string
  /** Frames from files under these directories are left out. */
  hide: string[]
  /** Terminal width, for truncating code frame lines. */
  columns?: number
}

/**
 * The error as the terminal shows it, with ANSI colours (renderers strip them when colour is
 * off): `Name: message`, the diff, then each stack frame with a code frame at the first one in
 * the project's own files, and any cause.
 */
export function formatError(error: unknown, options: FormatOptions): string {
  const lines: string[] = []
  printError(error, options, lines, true)
  return lines.join('\n')
}

function printError(
  error: unknown,
  options: FormatOptions,
  out: string[],
  showCodeFrame: boolean,
): void {
  let e = error as SerializedError
  if (e === null || (typeof e !== 'object' && typeof e !== 'function'))
    e = { message: String(error).split(/\n/g)[0], stack: String(error) }
  const hide = options.hide.map((dir) => comparable(dir))
  const stacks = parseErrorStacktrace(e as Error, {
    frameFilter: (_error, frame) =>
      !hide.some((dir) => comparable(frame.file).startsWith(dir)) &&
      !HIDDEN.some((dir) => comparable(frame.file).includes(dir)),
  })
  const nearest = stacks.find(
    (frame) => !comparable(frame.file).includes('/node_modules/') && existsSync(frame.file),
  )
  const name = e.name || 'Unknown Error'
  if (!e.message) out.push(inspect(e))
  else if (e.message.length > 5000) out.push(`${red(bold(name))}: ${e.message}`)
  else out.push(red(`${bold(name)}: ${e.message}`))
  if (e.codeFrame) out.push(`${e.codeFrame}\n`)
  if (e.diff) out.push(`\n${e.diff}\n`)
  if (e.frame) out.push(yellow(e.frame))
  else {
    for (const frame of stacks) {
      const color = frame === nearest ? cyan : gray
      const path = relativeFile(options.root, frame.file)
      out.push(
        color(
          ` ${dim(POINTER)} ${[frame.method, `${path}:${dim(`${frame.line}:${frame.column}`)}`].filter(Boolean).join(' ')}`,
        ),
      )
      if (showCodeFrame && frame === nearest) {
        const source = readFileSync(frame.file, 'utf8')
        out.push(codeFrame(source, 4, frame, options.columns ?? 80))
      }
    }
    if (stacks.length) out.push('')
    const properties = errorProperties(e)
    if (Object.keys(properties).length) {
      out.push(red(dim('⎯'.repeat(options.columns ?? 80))))
      out.push(`${red(bold('Serialized Error:'))} ${gray(inspect(properties))}`)
    }
  }
  if (e.cause != null) {
    let cause = e.cause as SerializedError
    if (typeof cause !== 'object') {
      const text = String(cause)
      cause = { name: 'Caused by', message: text, stack: text }
    } else if (!('name' in cause)) cause = { ...cause, name: 'Caused by' }
    else cause = { ...cause, name: `Caused by: ${cause.name}` }
    printError(cause, options, out, false)
  }
}

const SKIPPED = new Set([
  'cause',
  'stacks',
  'type',
  'showDiff',
  'ok',
  'operator',
  'diff',
  'codeFrame',
  'actual',
  'expected',
  'diffOptions',
  'runnerError',
  'sourceURL',
  'column',
  'line',
  'fileName',
  'lineNumber',
  'columnNumber',
  'VITEST_TEST_NAME',
  'VITEST_TEST_PATH',
  '__vitest_rollup_error__',
  '__vitest_error_context__',
  '__vitest_test_syntax_error__',
  ...Object.getOwnPropertyNames(Error.prototype),
  ...Object.getOwnPropertyNames(Object.prototype),
])

/** What else the error carries (a `code`, a response…), printed below the stack. */
function errorProperties(e: SerializedError): Record<string, unknown> {
  const properties: Record<string, unknown> = Object.create(null)
  if (e.name === 'AssertionError') return properties
  for (const key of Object.getOwnPropertyNames(e)) {
    if (key === 'stack') {
      if (e.stack != null && typeof e.stack !== 'string') properties.stack = e.stack
    } else if (!SKIPPED.has(key)) properties[key] = e[key]
  }
  return properties
}

const lineNo = (no: number | '' = '') => gray(`${String(no).padStart(3, ' ')}|`)

/** Two lines either side of `loc`, with a caret under it. */
export function codeFrame(
  source: string,
  indent: number,
  loc: { line: number; column: number },
  columns: number,
  range = 2,
): string {
  const start = positionToOffset(source, loc.line, loc.column)
  const lines = source.split(lineSplitRE)
  const nl = /\r\n/.test(source) ? 2 : 1
  let count = 0
  const res: string[] = []
  for (let i = 0; i < lines.length; i++) {
    count += (lines[i] as string).length + nl
    if (count < start) continue
    for (let j = Math.max(0, i - range); j <= i + range && j < lines.length; j++) {
      const line = lines[j] as string
      const stripped = stripVTControlCharacters(line)
      if (stripped.startsWith('//# sourceMappingURL')) continue
      // Too long: probably minified, where a frame shows nothing useful.
      if (stripped.length > 200) return ''
      const truncated = truncateString(line.replace(/\t/g, ' '), columns - 5 - indent).trimEnd()
      res.push(lineNo(j + 1) + (truncated ? ` ${truncated}` : truncated))
      if (j === i) {
        const pad = start - (count - line.length) + (nl - 1)
        res.push(lineNo() + ' '.repeat(pad + 1) + red('^'))
      }
    }
    break
  }
  return res.map((line) => ' '.repeat(indent) + line).join('\n')
}
