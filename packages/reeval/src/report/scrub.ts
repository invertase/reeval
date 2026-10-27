import { realpathSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { COMMANDS, FLAGS, type FlagName, isFlagName } from '../cli-spec.ts'
import { mapJsonStrings, REDACTED, redactKey, redactSecrets, registerSecret } from '../redact.ts'

export type Scrubber = {
  /** Masks secrets as records are masked, then the project root and the home directory. */
  text: (text: string) => string
  /** The same over every string (and key) in a value. */
  value: <T>(value: T) => T
  /** The same over the strings of serialized JSON or JSON Lines, which stays valid. */
  json: (text: string) => string
  /** What was replaced: `~`, and `<project>` when there's a project. */
  paths: string[]
}

const variants = (path: string | undefined) => {
  if (!path || path === '/' || path.length < 2) return []
  const out = new Set([path.replace(/[\\/]+$/, '')])
  try {
    out.add(realpathSync(path))
  } catch {}
  for (const p of [...out]) if (p.includes('\\')) out.add(p.replaceAll('\\', '/'))
  // Longest first, so /private/var/… goes before /var/….
  return [...out].sort((a, b) => b.length - a.length)
}

/**
 * The home directory as Windows' 8.3 short name (`C:\\Users\\RUNNER~1`), which TEMP often spells it
 * with: TEMP's long form is under the home, and TEMP ends as that does.
 */
export function shortHome(
  home: string | undefined,
  temp: string | undefined,
  long: (path: string) => string = realpathSync.native,
): string | undefined {
  if (!home || !temp) return undefined
  let full: string
  try {
    full = long(temp)
  } catch {
    return undefined
  }
  const lower = (p: string) => p.toLowerCase().replace(/[\\/]+$/, '')
  if (!lower(full).startsWith(lower(home))) return undefined
  const suffix = full.replace(/[\\/]+$/, '').slice(home.replace(/[\\/]+$/, '').length)
  if (!suffix || !lower(temp).endsWith(suffix.toLowerCase())) return undefined
  const short = temp.replace(/[\\/]+$/, '').slice(0, -suffix.length)
  return lower(short) === lower(home) ? undefined : short
}

export function scrubber(options: {
  env: NodeJS.ProcessEnv
  home?: string
  project?: string
}): Scrubber {
  const project = variants(options.project)
  const short = shortHome(options.home, options.env.TEMP ?? options.env.TMP)
  const home = [...variants(options.home), ...variants(short)].sort((a, b) => b.length - a.length)
  const replace = (text: string, froms: string[], to: string) => {
    let out = text
    for (const from of froms) out = out.replaceAll(from, to)
    return out
  }
  const paths = (input: string) => replace(replace(input, project, '<project>'), home, '~')
  const text = (input: string) => paths(redactSecrets(input, options.env))
  const key = (input: string) => paths(redactKey(input, options.env))
  const value = <T>(input: T): T => {
    if (typeof input === 'string') return text(input) as T
    if (Array.isArray(input)) return input.map(value) as T
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [key(k), value(v)])) as T
    }
    return input
  }
  const json = (input: string) => mapJsonStrings(input, (s, isKey) => (isKey ? key(s) : text(s)))
  return { text, value, json, paths: ['~', ...(project.length ? ['<project>'] : [])] }
}

/** How many masked values `text` shows. */
export const masks = (text: string) => text.split(REDACTED).length - 1

/**
 * Registers every value in a `.env.local` or `.env` as a secret, whatever its name: a report is
 * meant to leave the machine, so it masks more than a record.
 */
export function registerEnvFileValues(contents: string): void {
  for (const value of Object.values(parseEnv(contents))) {
    if (value && value.length >= 8) registerSecret(value)
  }
}

const shortFlag = (letter: string) =>
  (Object.entries(FLAGS) as Array<[FlagName, (typeof FLAGS)[FlagName]]>).find(
    ([, s]) => 'short' in s && s.short === letter,
  )?.[0]

/**
 * `reeval`'s arguments with every value replaced: command names and flag names stay, a flag's value
 * becomes `<value>`, any other argument (filters, run ids, SQL, paths) `<arg>`, and a flag reeval
 * doesn't know `<flag>`.
 */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = []
  let commands: Record<string, unknown> | undefined = COMMANDS
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      out.push('--', ...argv.slice(i + 1).map(() => '<arg>'))
      break
    }
    if (/^-v+$/.test(arg)) {
      out.push(arg)
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=')
      const head = eq === -1 ? arg : arg.slice(0, eq)
      const name = head.startsWith('--') ? head.slice(2) : shortFlag(head.slice(1))
      const spec = name && isFlagName(name) ? FLAGS[name] : undefined
      if (!spec) {
        out.push('<flag>')
        continue
      }
      if (eq !== -1) out.push(`${head}=<value>`)
      else {
        out.push(head)
        if (spec.type === 'string' && i + 1 < argv.length) {
          out.push('<value>')
          i++
        }
      }
      continue
    }
    const command = commands?.[arg] as { sub?: Record<string, unknown> } | undefined
    if (command) {
      out.push(arg)
      commands = commands === COMMANDS ? command.sub : undefined
      continue
    }
    commands = undefined
    out.push('<arg>')
  }
  return out
}

/** The command an argv names: `run`, `studio build`, or null. */
export function commandOf(argv: string[]): string | null {
  const words = redactArgv(argv).filter((w) => !w.startsWith('-') && !w.startsWith('<'))
  return words.length ? words.join(' ') : null
}
