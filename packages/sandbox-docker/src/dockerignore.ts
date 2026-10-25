import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'

type Rule = {
  /** A `!` rule, which re-includes what it matches. */
  negate: boolean
  pattern: string
  matches: (path: string) => boolean
}

/** A path's match against each rule, which its children start from. */
type Matched = readonly boolean[]

const REGEXP_SPECIAL = new Set(['.', '+', '(', ')', '{', '}', '$', '|'])

/**
 * A cleaned pattern as moby/patternmatcher matches it: a literal path, a `dir/**` prefix, a
 * `**suffix`, or else a regexp over code points, as Go's are, where `*` and `?` stay within a
 * segment and `**` spans whole directories. A pattern Docker refuses as invalid matches nothing here.
 */
function compile(pattern: string): (path: string) => boolean {
  const chars = [...pattern]
  let type: 'exact' | 'prefix' | 'suffix' | 'regexp' = 'exact'
  let re = '^'
  let inClass = false
  for (let i = 0; i < chars.length; i++) {
    const start = i
    const c = chars[i] as string
    if (c === '*' && chars[i + 1] === '*') {
      i++
      if (chars[i + 1] === '/') i++
      if (i + 1 === chars.length) {
        if (type === 'exact') type = 'prefix'
        else {
          re += '.*'
          type = 'regexp'
        }
      } else {
        re += '(.*/)?'
        type = 'regexp'
      }
      if (start === 0) type = 'suffix'
    } else if (c === '*') {
      re += '[^/]*'
      type = 'regexp'
    } else if (c === '?') {
      re += '[^/]'
      type = 'regexp'
    } else if (REGEXP_SPECIAL.has(c)) re += `\\${c}`
    else if (c === '\\') {
      if (i + 1 === chars.length) return () => false
      const next = chars[++i] as string
      re += /[A-Za-z0-9]/.test(next) ? `\\${next}` : `\\u{${next.codePointAt(0)?.toString(16)}}`
      type = 'regexp'
    } else if (c === '[' || c === ']') {
      re += c === ']' && !inClass ? '\\]' : c
      inClass = c === '[' || (inClass && c !== ']')
      type = 'regexp'
    } else re += c
  }
  if (type === 'exact') return (path) => path === pattern
  if (type === 'prefix') {
    const prefix = pattern.slice(0, -2)
    return (path) => path.startsWith(prefix)
  }
  if (type === 'suffix') {
    const suffix = pattern.slice(2)
    return (path) => path.endsWith(suffix) || (suffix[0] === '/' && path === suffix.slice(1))
  }
  try {
    const regexp = new RegExp(`${re}$`, 'u')
    return (path) => regexp.test(path)
  } catch {
    return () => false
  }
}

/** `.dockerignore` lines as Docker reads them: a `#` line is a comment, and each pattern is cleaned. */
function parseRules(text: string): Rule[] {
  const rules: Rule[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.startsWith('#')) continue
    let pattern = line.trim()
    if (!pattern) continue
    const negate = pattern.startsWith('!')
    if (negate) pattern = pattern.slice(1).trim()
    if (!pattern) continue
    pattern = posix.normalize(pattern)
    if (pattern.length > 1) pattern = pattern.replace(/\/$/, '')
    if (pattern.length > 1 && pattern.startsWith('/')) pattern = pattern.slice(1)
    rules.push({ negate, pattern, matches: compile(pattern) })
  }
  return rules
}

/**
 * Whether `path` is excluded, from what its parent directory matched, as BuildKit's walk decides
 * it: a rule its parent matched still matches, the last matching rule wins, and a rule that
 * couldn't change the outcome when it's reached isn't tried (so a re-include of `dir` doesn't
 * reach `dir/file` that a rule before it excluded).
 */
function match(
  rules: Rule[],
  path: string,
  parent: Matched,
): { excluded: boolean; matched: Matched } {
  const matched = rules.map(() => false)
  let excluded = false
  rules.forEach((rule, i) => {
    let hit = parent[i] ?? false
    if (!hit) {
      if (rule.negate !== excluded) return
      hit = rule.matches(path)
    }
    matched[i] = hit
    if (hit) excluded = !rule.negate
  })
  return { excluded, matched }
}

/**
 * `.dockerignore` rules as Docker reads them: paths from the context root, `*`, `?`, `[…]` and `**`
 * globs, a pattern that matches a directory excludes what's in it, `!` re-includes, and the last
 * matching rule wins.
 */
export function dockerignoreMatcher(text: string): (path: string) => boolean {
  const rules = parseRules(text)
  return (path) => {
    const parts = path.split('/')
    let result = { excluded: false, matched: [] as Matched }
    for (let i = 0; i < parts.length; i++) {
      result = match(rules, parts.slice(0, i + 1).join('/'), result.matched)
    }
    return result.excluded
  }
}

/**
 * Files in the build context that `docker build` would send, sorted, relative to `context`, plus
 * the Dockerfile and `.dockerignore`. A Dockerfile read from stdin (`dockerfile` null) has no
 * `<Dockerfile>.dockerignore` of its own. An excluded directory is skipped only where BuildKit
 * skips it: when every `!` rule is a literal path (less a trailing `/**`, then a trailing `/*`)
 * outside it, so a re-include of everything under `a`'s subdirectories reaches none of them.
 */
export function contextFiles(context: string, dockerfile: string | null): string[] {
  const own = [
    ...(dockerfile ? [`${dockerfile}.dockerignore`] : []),
    join(context, '.dockerignore'),
  ].find(existsSync)
  const rules = parseRules(own ? readFileSync(own, 'utf8') : '')
  const reincludes = rules
    .filter((rule) => rule.negate)
    .map((rule) => rule.pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, ''))
  const literal = reincludes.every((pattern) => !/[*?[\]^\\]/.test(pattern))
  const always = new Set([...(dockerfile ? [relative(context, dockerfile)] : []), '.dockerignore'])
  const files: string[] = []
  const walk = (rel: string, parent: Matched) => {
    for (const entry of readdirSync(join(context, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      const { excluded, matched } = match(rules, path, parent)
      if (entry.isDirectory()) {
        const skip = excluded && literal && !reincludes.some((p) => `${p}/`.startsWith(`${path}/`))
        if (!skip) walk(path, matched)
      } else if (!excluded || always.has(path)) files.push(path)
    }
  }
  walk('', [])
  return files.sort()
}
