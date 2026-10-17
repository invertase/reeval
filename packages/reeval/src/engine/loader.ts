// Loads an eval file in a worker: TypeScript, ESM or CommonJS, with extensionless imports, through
// jiti. The file's tsconfig.json must load (jiti uses it like any TypeScript runner): a
// broken one fails every eval file under it, loudly.
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { DecodedMap, getOriginalPosition } from '@vitest/utils/source-map'
import { getTsconfig } from 'get-tsconfig'
import { relativeFile } from '../ids.ts'
import { reevalJiti } from '../jiti.ts'
import { codeFrame } from './errors.ts'

export class TsconfigError extends Error {
  override name = 'TsconfigError'
}

/** Each file jiti transformed: its source map, and how far jiti's wrapper shifts line 1. */
const transformed = new Map<string, { map: DecodedMap; shift: number }>()

const INLINE_MAP =
  /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/

/** Imports `file` and whatever it imports. */
export async function loadEvalFile(file: string, root: string): Promise<unknown> {
  checkTsconfig(dirname(file), root)
  const options = { moduleCache: true, fsCache: false, sourceMaps: true }
  const base = await reevalJiti(file, options)
  const jiti = await reevalJiti(file, {
    ...options,
    transform: (opts) => {
      const code = base.transform(opts)
      const inline = INLINE_MAP.exec(code)
      if (opts.filename && inline?.[1]) {
        const map = JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8'))
        // jiti evaluates the code inside `(function (…) { <code>`, on the code's first line.
        const shift =
          `(${opts.async ? 'async ' : ''}function (exports, require, module, __filename, __dirname, jitiImport, jitiESMResolve) { `
            .length
        transformed.set(opts.filename, { map: new DecodedMap(map, opts.filename), shift })
      }
      return { code }
    },
  })
  try {
    return await jiti.import(file)
  } catch (error) {
    throw syntaxError(error, root) ?? missingModule(error)
  }
}

/** jiti's `Cannot find module 'x'` plus a require stack, as `… imported from <file>`. */
function missingModule(error: unknown): unknown {
  const e = error as Error & { code?: string }
  if (e?.code !== 'MODULE_NOT_FOUND') return error
  const parts = /^(Cannot find module '[^']+')\nRequire stack:\n- (.+)/.exec(e.message)
  if (parts) e.message = `${parts[1]} imported from ${parts[2]}`
  return error
}

/**
 * jiti reports a parse error as a plain Error, `ParseError: <reason>` then ` <file>:<line>:<col>`
 * (col 0-based): a SyntaxError again, naming the file and position, with a code frame.
 */
export function syntaxError(error: unknown, root: string): SyntaxError | undefined {
  const parsed = /^ParseError: (.*?)\s*\n\s*(.+):(\d+):(\d+)$/.exec((error as Error)?.message ?? '')
  if (!parsed) return undefined
  const [, said, file, line, column] = parsed as unknown as [string, string, string, string, string]
  // On Windows the reason starts with a path of its own (`C:\: Unexpected token`).
  const reason = said.replace(/^(?:[A-Za-z]:)?[\\/]\S*?: /, '')
  const at = { line: Number(line), column: Number(column) + 1 }
  let frame = ''
  try {
    frame = stripVTControlCharacters(codeFrame(readFileSync(file, 'utf8'), 0, at, 200))
  } catch {}
  return new SyntaxError(
    `${reason} (${relativeFile(root, file)}:${at.line}:${at.column})${frame ? `\n${frame}` : ''}`,
  )
}

/** `stack` with positions in transformed files mapped back to their sources. */
export function originalStack(stack: string): string {
  return stack.replace(
    /^(\s+at (?:.*\()?)(.+?):(\d+):(\d+)(\)?)$/gm,
    (whole, before: string, file: string, line: string, column: string, after: string) => {
      const loaded = transformed.get(file)
      const at0 = Number(column) - 1 - (line === '1' ? (loaded?.shift ?? 0) : 0)
      // Not a transformed file, or a frame in jiti's own wrapper.
      if (!loaded || at0 < 0) return whole
      const at = getOriginalPosition(loaded.map, { line: Number(line), column: at0 })
      if (!at) return whole
      const original = at.line as number
      return `${before}${file}:${original}:${callee(file, original, at.column as number) + 1}${after}`
    },
  )
}

/**
 * Where V8 would put a call's position without the transform: jiti calls an imported function as
 * `(0, _module.fn)()`, which V8 reports at the `(`, where a plain `fn()` reports at `fn`.
 */
function callee(file: string, line: number, column: number): number {
  // The file may have changed since it was loaded; then there's nothing to adjust.
  const text = readFileSync(file, 'utf8').split(/\r?\n/)[line - 1] ?? ''
  if (text[column] !== '(') return column
  let start = column
  while (start > 0 && /[\w$]/.test(text[start - 1] as string)) start--
  return start
}

/** Fails when the nearest tsconfig.json isn't valid JSON with comments, or extends a missing file. */
export function checkTsconfig(dir: string, root: string): void {
  let found: ReturnType<typeof getTsconfig>
  try {
    found = getTsconfig(dir)
  } catch (error) {
    const message = (error as Error).message
    const missing = /^File '(.+)' not found\.$/.exec(message)
    throw new TsconfigError(
      missing
        ? `Failed to load tsconfig '${missing[1]}': Tsconfig not found`
        : `Failed to load tsconfig: ${message}`,
    )
  }
  if (!found) return
  try {
    JSON.parse(stripJsonComments(readFileSync(found.path, 'utf8')))
  } catch (error) {
    throw new TsconfigError(
      `Failed to load tsconfig '${relativeFile(root, found.path)}': ${(error as Error).message}`,
    )
  }
}

/** JSON with comments and trailing commas (tsconfig's dialect) as plain JSON. */
export function stripJsonComments(text: string): string {
  return scan(
    scan(text, (rest) => {
      if (rest.startsWith('//')) {
        const end = rest.indexOf('\n')
        return [end < 0 ? rest.length : end, '']
      }
      if (rest.startsWith('/*')) {
        const end = rest.indexOf('*/', 2)
        return [end < 0 ? rest.length : end + 2, ' ']
      }
      return undefined
    }),
    (rest) => (/^,\s*[}\]]/.test(rest) ? [1, ' '] : undefined),
  )
}

/** Rewrites `text` outside its strings: `at` says how much to replace here, and with what. */
function scan(text: string, at: (rest: string) => [number, string] | undefined): string {
  let out = ''
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      let end = i + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      out += text.slice(i, end + 1)
      i = end + 1
      continue
    }
    const hit = at(text.slice(i))
    if (hit) {
      out += hit[1]
      i += hit[0]
    } else out += text[i++]
  }
  return out
}
