import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import dockerignore from '@balena/dockerignore'

const ignore = dockerignore.default

/**
 * A pattern `@balena/dockerignore` may match differently from BuildKit: escapes, character
 * classes and the regexp characters it doesn't escape, a `**` joined to other characters, and the
 * whitespace Go and JavaScript trim differently.
 */
const RISKY = /[\\[\]^+(){}|\u0085\uFEFF]|[^/]\*\*|\*\*[^/]/
/** `?` matches one UTF-16 unit in `@balena/dockerignore` and one code point in BuildKit. */
const ASTRAL = /[\u{10000}-\u{10FFFF}]/u

const clean = (pattern: string) => posix.normalize(pattern).replace(/^\/+/, '').replace(/\/+$/, '')

type Rules = {
  /** Whether reeval leaves the path out of a hash. */
  left: (path: string) => boolean
  /** The `!` rules, cleaned, when every one is a literal path. */
  literal: string[] | null
}

/**
 * `.dockerignore` lines as Docker reads them: a BOM is dropped, a line starting `#` is a comment,
 * and `!` re-includes. A path is left out when a rule excludes it and no `!` rule matches it or a
 * directory it's in: BuildKit then excludes it whatever order the rules are in, so this never
 * leaves out a file `docker build` sends, though it keeps some it doesn't. A risky exclusion is
 * dropped, and a risky `!` rule (or one `@balena/dockerignore` would read as a comment) keeps
 * everything.
 */
function parseRules(text: string): Rules {
  const excludes: string[] = []
  const reincludes: string[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.startsWith('#')) continue
    let pattern = line.trim()
    const negate = pattern.startsWith('!')
    if (negate) pattern = pattern.slice(1).trim()
    if (!pattern) continue
    const risky = RISKY.test(pattern) || ['.', ''].includes(clean(pattern))
    if (!negate) {
      if (!risky) excludes.push(line)
    } else if (risky || pattern.startsWith('#')) return { left: () => false, literal: null }
    else reincludes.push(pattern)
  }
  const exclude = ignore({ ignorecase: false }).add(excludes)
  const reinclude = ignore({ ignorecase: false }).add(reincludes)
  return {
    left: (path) => !ASTRAL.test(path) && exclude.ignores(path) && !reinclude.ignores(path),
    literal: reincludes.some((p) => /[*?]/.test(p)) ? null : reincludes.map(clean),
  }
}

/** Whether reeval leaves `path` out of a hash under these `.dockerignore` rules. */
export function dockerignoreMatcher(text: string): (path: string) => boolean {
  return parseRules(text).left
}

/**
 * Files in the build context that reeval hashes, sorted, relative to `context`: every file
 * `docker build` sends (and some it doesn't), plus the Dockerfile and `.dockerignore`. A
 * Dockerfile read from stdin (`dockerfile` null) has no `<Dockerfile>.dockerignore` of its own.
 * A left-out directory is skipped only when every `!` rule is a literal path outside it.
 */
export function contextFiles(context: string, dockerfile: string | null): string[] {
  const own = [
    ...(dockerfile ? [`${dockerfile}.dockerignore`] : []),
    join(context, '.dockerignore'),
  ].find(existsSync)
  const { left, literal } = parseRules(own ? readFileSync(own, 'utf8') : '')
  const always = [...(dockerfile ? [relative(context, dockerfile)] : []), '.dockerignore'].map(
    (path) => path.split('\\').join('/'),
  )
  const reach = [...always, ...(literal ?? [])]
  const files: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(context, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const skip = left(path) && literal && !reach.some((p) => p.startsWith(`${path}/`))
        if (!skip) walk(path)
      } else if (!left(path) || always.includes(path)) files.push(path)
    }
  }
  walk('')
  return files.sort()
}
