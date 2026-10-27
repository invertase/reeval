// Holds every link to a documentation page to the sidebar's paths. docs.mjs --check calls it.
//
// docs.json's sidebar owns the paths. A path the sidebar doesn't own is an old one: it keeps a
// redirect in docs.json so old URLs resolve, and nothing in the docs, the README, the skills or
// the examples links to it.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { headingIds, internalLinks } from './docs-anchors.mjs'

/**
 * Paths of earlier docs layouts that the archived pages (docs-archive/) don't name: the section
 * roots and the pages of the layout before the sidebar's. Each keeps a redirect.
 */
export const LEGACY_PATHS = [
  '/comparisons/compare',
  '/comparisons/statistics',
  '/concepts',
  '/core-concepts',
  '/evals',
  '/evals/ci',
  '/evals/profiles',
  '/evals/running',
  '/gateways',
  '/guide/analysis',
  '/harnesses',
  '/history',
  '/history/queries',
  '/history/studio',
  '/recipes',
  '/reference',
  '/sandboxes',
]

/**
 * Pages whose URL is not the path their groups and title make. Overview is the landing
 * page: its URL is its title's slug, `/overview`, and `/` redirects there, so the
 * Getting started group does not prefix it. Run output keeps its address while its
 * title is open to change.
 */
export const TITLE_EXCEPTIONS = { Overview: '/overview', 'Run output': '/results/output' }

const SKIPPED = /^(?:docs-archive|\.git|node_modules)\//

/** The path of a docs URL or link target: no query, no #anchor, no trailing slash. */
export function pathOf(target) {
  const path = target.split('#')[0].split('?')[0].replace(/\/+$/, '')
  return path === '' ? '/' : path
}

/** The sidebar's hrefs, nested groups included. */
export function sidebarHrefs(config) {
  const hrefs = []
  const walk = (items) => {
    for (const item of items) {
      if (item.pages) walk(item.pages)
      if (item.href?.startsWith('/')) hrefs.push(item.href)
    }
  }
  walk(config.sidebar)
  return hrefs
}

/** `Measure MCP servers` is `measure-mcp-servers`. */
export function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The sidebar's titles and URLs, held together: a page's path is its enclosing groups' slugs and
 * its own title's slug, so a title says where the page lives. A group with an `href` lands on
 * the same path built from its own name.
 */
export function titleProblems(config) {
  const problems = []
  const walk = (items, chain) => {
    for (const item of items) {
      const name = item.title ?? item.group
      if (item.href && name) {
        const expected = TITLE_EXCEPTIONS[name] ?? `/${[...chain, slug(name)].join('/')}`
        if (item.href !== expected) {
          problems.push(
            `docs.json: "${name}" is at ${item.href}, but its title makes it ${expected}: move the page, update its links and redirect the old path`,
          )
        }
      }
      if (item.pages) walk(item.pages, item.group ? [...chain, slug(item.group)] : chain)
    }
  }
  walk(config.sidebar, [])
  return problems
}

/** The URL path a page file under `dir` serves: `docs/evaluations/evaluate.mdx` is `/evaluations/evaluate`. */
function urlOf(dir, file) {
  const path = `/${relative(dir, file)
    .replace(/\\/g, '/')
    .replace(/\.mdx?$/, '')}`
  return path.replace(/\/index$/, '') || '/'
}

function pagesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? pagesUnder(join(dir, entry.name))
      : /\.mdx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )
}

/** Every old path: the archived pages' URLs and LEGACY_PATHS, less what the sidebar owns. */
export function oldPaths({ root, config }) {
  const owned = new Set(sidebarHrefs(config))
  const old = new Set(LEGACY_PATHS)
  for (const file of pagesUnder(join(root, 'docs-archive'))) {
    old.add(urlOf(join(root, 'docs-archive'), file))
  }
  for (const source of Object.keys(config.redirects ?? {})) old.add(source)
  return [...old].filter((path) => !owned.has(path)).sort()
}

/** The text files that may link to a docs page, from git. */
function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\0')
      .filter((file) => file && !SKIPPED.test(file))
  } catch {
    return []
  }
}

const TEXT = /\.(?:mdx?|json|tsx?|mjs|cjs|ya?ml|py|toml|txt|sh)$/
const FIXTURES = /(?:^|\/)(?:fixtures|replay|schema|test\/fixtures)\//

/**
 * The URL of a docs page in running text: the docs.page preview or published address, or a
 * `reeval.ai/docs` one. Captures the path.
 */
const DOC_URL =
  /\bhttps?:\/\/(?:docs\.page\/invertase\/reeval(?:~[^/\s)"'`>]+)?|docs\.reeval\.ai(?:\/~[^/\s)"'`>]+)?|(?:www\.)?reeval\.ai\/docs)((?:\/[A-Za-z0-9_.\-%]+)*)\/?(?=[#?\s)"'`>\]]|$)/g

/**
 * A problem for each of: a sidebar page whose path isn't its title's; a redirect that points at a path the sidebar doesn't own, or that
 * shadows a page the sidebar lists; an old path with no redirect; and a link to an old path (in a
 * page, in docs.json, or as a documentation URL anywhere in the repository) or a relative link
 * from outside docs/ to a docs file or heading that doesn't exist.
 */
export function linkProblems({ root, config }) {
  const problems = []
  const owned = new Set(sidebarHrefs(config))
  const redirects = config.redirects ?? {}
  problems.push(...titleProblems(config))
  const variables = config.variables ?? {}
  const fill = (text) =>
    text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, name) => variables[name] ?? all)

  for (const [source, target] of Object.entries(redirects)) {
    if (owned.has(source)) {
      problems.push(`docs.json redirects ${source}, a path the sidebar owns: delete the redirect`)
    }
    if (!owned.has(pathOf(target))) {
      problems.push(
        `docs.json redirects ${source} to ${target}, which the sidebar doesn't own: point it at a sidebar page`,
      )
    }
  }
  for (const path of oldPaths({ root, config })) {
    if (!(path in redirects)) {
      problems.push(`${path} is an old docs path with no redirect in docs.json: add one`)
    }
  }

  const fix = (path) => {
    const to = redirects[pathOf(path)]
    return to ? `use ${to}` : 'the sidebar has no such page'
  }

  for (const [index, anchor] of (config.anchors ?? []).entries()) {
    if (anchor.href?.startsWith('/') && !owned.has(pathOf(anchor.href))) {
      problems.push(
        `docs.json anchors[${index}] links ${anchor.href}, which the sidebar doesn't own`,
      )
    }
  }

  const old = new Set(oldPaths({ root, config }))
  const headings = new Map()
  const idsOf = (file) => {
    if (!headings.has(file))
      headings.set(file, new Set(headingIds(fill(readFileSync(file, 'utf8')))))
    return headings.get(file)
  }

  for (const file of trackedFiles(root)) {
    if (!TEXT.test(file) || FIXTURES.test(file)) continue
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    if (file === 'docs.json') continue
    const inDocs = file.startsWith('docs/')

    if (inDocs && file.endsWith('.mdx')) {
      for (const { target, line } of internalLinks(text)) {
        const path = pathOf(target)
        if (target.startsWith('#') || !old.has(path)) continue
        problems.push(`${file}:${line} links the old path ${path}: ${fix(path)}`)
      }
    }

    for (const match of text.matchAll(DOC_URL)) {
      const path = pathOf(match[1] || '/')
      const line = text.slice(0, match.index).split('\n').length
      if (old.has(path) || (!owned.has(path) && path !== '/')) {
        problems.push(`${file}:${line} links the old docs URL ${match[0]}: ${fix(path)}`)
      }
    }

    if (!inDocs && file.endsWith('.md')) {
      const directory = dirname(join(root, file))
      for (const match of text.matchAll(/\]\(\s*<?((?:\.{1,2}\/)*docs\/[^)\s>#]*)(#[^)\s>]*)?/g)) {
        const target = resolve(directory, match[1])
        const line = text.slice(0, match.index).split('\n').length
        const where = `${file}:${line}`
        if (!existsSync(target)) {
          problems.push(
            `${where} links ${match[1]}, which doesn't exist: link a page the sidebar lists`,
          )
          continue
        }
        const anchor = match[2]?.slice(1)
        if (anchor && statSync(target).isFile() && !idsOf(target).has(decodeURIComponent(anchor))) {
          problems.push(`${where} links ${match[1]}#${anchor}, but the page has no such heading`)
        }
      }
    }
  }
  return problems
}
