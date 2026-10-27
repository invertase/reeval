// Holds every internal docs link's #anchor to a heading on the page it points at. docs.mjs --check
// calls it. The heading ids are docs.page's own: packages/mdx-bundler/src/markdown/headings.ts in
// https://github.com/invertase/docs.page (extractHeadingNodes, slugifyHeading), copied here so a
// slug differs only when docs.page changes its rules.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const decodeEntities = (value) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))

function cleanHeadingTitle(raw) {
  let title = raw.trim()
  title = title.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  title = title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  title = title.replace(/`([^`]+)`/g, '$1')
  title = title.replace(/<[^>]+>/g, '')
  title = decodeEntities(title)
  title = title.replace(/(\*\*|__)(.+?)\1/g, '$2')
  title = title.replace(/(\*|_)(.+?)\1/g, '$2')
  title = title.replace(/~~(.+?)~~/g, '$1')
  return title.replace(/\s+/g, ' ').trim()
}

/** docs.page's slug for a heading's cleaned text. */
export function slugifyHeading(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return slug || 'section'
}

const fenceRun = (line) => {
  const token = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
  return token ? { marker: token[0], length: token.length } : null
}

/** Each line of `markdown` that is not inside a fenced code block, with its 1-based number. */
export function* linesOutsideFences(markdown) {
  let active = null
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const fence = fenceRun(line)
    if (fence) {
      if (!active) active = fence
      else if (active.marker === fence.marker && fence.length >= active.length) active = null
      continue
    }
    if (!active) yield { line, number: index + 1 }
  }
}

/** The ids docs.page gives the headings of a page, in order; repeats get `-1`, `-2`, …. */
export function headingIds(markdown) {
  const counts = new Map()
  const ids = []
  for (const { line } of linesOutsideFences(markdown)) {
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const title = cleanHeadingTitle(match[2].replace(/\s+#+\s*$/, '').trim())
    if (!title) continue
    const base = slugifyHeading(title)
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    ids.push(seen === 0 ? base : `${base}-${seen}`)
  }
  return ids
}

/** The internal links on a page: Markdown `](target)` and JSX `href="target"`, outside code. */
export function internalLinks(markdown) {
  const links = []
  for (const { line, number } of linesOutsideFences(markdown)) {
    const text = line.replace(/`[^`\n]*`/g, '')
    const targets = [
      ...[...text.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]),
      ...[...text.matchAll(/\bhref=(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\})/g)].map(
        (m) => m[1] ?? m[2] ?? m[3],
      ),
    ]
    for (const target of targets) {
      if (target.startsWith('/') || target.startsWith('#')) links.push({ target, line: number })
    }
  }
  return links
}

function mdxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? mdxFiles(join(dir, e.name))
      : e.name.endsWith('.mdx')
        ? [join(dir, e.name)]
        : [],
  )
}

/**
 * A problem for each internal link to a page that doesn't exist or to an #anchor that no heading
 * on that page has. `variables` fill `{{ name }}` the way docs.page does before it slugs a
 * heading.
 */
export function anchorProblems({ root, docsDir, variables = {} }) {
  const fill = (text) =>
    text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, name) => variables[name] ?? all)
  const pages = new Map()
  const pageFor = (href) => {
    const base = join(docsDir, href === '/' ? 'index' : href.replace(/^\//, '').replace(/\/$/, ''))
    return [`${base}.mdx`, join(base, 'index.mdx')].find(existsSync)
  }
  const idsOf = (file) => {
    if (!pages.has(file)) pages.set(file, new Set(headingIds(fill(readFileSync(file, 'utf8')))))
    return pages.get(file)
  }
  const problems = []
  for (const file of mdxFiles(docsDir)) {
    for (const { target, line } of internalLinks(readFileSync(file, 'utf8'))) {
      const hash = target.indexOf('#')
      const href = hash === -1 ? target : target.slice(0, hash)
      const anchor = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1))
      const where = `${relative(root, file)}:${line}`
      const destination = href === '' ? file : pageFor(href.split('?')[0])
      if (!destination) {
        problems.push(`${where} links ${target}, but no page under docs/ has the path ${href}`)
        continue
      }
      if (anchor && !idsOf(destination).has(anchor)) {
        problems.push(
          `${where} links ${target}, but ${relative(root, destination)} has no heading with the id "${anchor}"`,
        )
      }
    }
  }
  return problems
}
