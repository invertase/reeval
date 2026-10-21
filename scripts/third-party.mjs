// The third-party code inlined into reeval's tarball, for its THIRD_PARTY_NOTICES.md.
// rollup-plugin-license lists the packages whose modules land in a bundle (tsdown's, and the
// studio app's Vite build); packages that reach it other ways (CSS @imports, files copied from a
// package) are added by path. Every one must carry a licence in ALLOWED, and a licence file
// where its licence asks for the notice to ship; otherwise the build fails. The package's own
// `dependencies` aren't inlined: installers fetch them, notices and all.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import license from 'rollup-plugin-license'
import validate from 'spdx-expression-validate'
import satisfies from 'spdx-satisfies'

/** Licences bundled code may carry (an `OR` needs one of them, an `AND` all). */
export const ALLOWED = [
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
]
/** Of those, the ones that don't ask for their text to ship with the code. */
const NO_NOTICE = ['MIT-0', '0BSD', 'CC0-1.0', 'Unlicense']

const root = join(import.meta.dirname, '..')
/** The workspace's own packages, which the studio reaches by path (`reeval/view`). */
const own = new Set(
  readdirSync(join(root, 'packages')).map(
    (dir) => JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')).name,
  ),
)

/**
 * @typedef {{ name: string, version: string, license: string, licenseText: string | null,
 *   noticeText: string | null, source: string | null, where: string[], modified?: string }} ThirdParty
 */

/**
 * Licence files for packages whose tarball leaves theirs out, from their repository, named by
 * package (`@scope__name`). Check a new one is the version's licence before adding it.
 */
const missingLicenses = join(import.meta.dirname, 'third-party-licenses')

/** @returns {ThirdParty} */
function entry(pkg, licenseText, noticeText, where) {
  const id = `${pkg.name}@${pkg.version}`
  const spdx = typeof pkg.license === 'string' ? pkg.license : null
  if (!spdx || !validate(spdx))
    throw new Error(`${id} is bundled but has no SPDX licence (${JSON.stringify(pkg.license)})`)
  if (!satisfies(spdx, ALLOWED))
    throw new Error(`${id} is bundled but its licence, ${spdx}, isn't allowed (${ALLOWED})`)
  const fallback = join(missingLicenses, pkg.name.replace('/', '__'))
  if (!licenseText && existsSync(fallback)) licenseText = readFileSync(fallback, 'utf8')
  if (!licenseText && !satisfies(spdx, NO_NOTICE))
    throw new Error(
      `${id} is bundled but ships no LICENSE file for its ${spdx} notice: add its licence ` +
        `from its repository as scripts/third-party-licenses/${pkg.name.replace('/', '__')}`,
    )
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return {
    name: pkg.name,
    version: pkg.version,
    license: spdx,
    licenseText: licenseText?.replaceAll('\r\n', '\n').trim() || null,
    noticeText: noticeText?.replaceAll('\r\n', '\n').trim() || null,
    source: repo ?? pkg.homepage ?? null,
    where: [where],
  }
}

/**
 * rollup-plugin-license for a Rolldown or Vite build: `output` gets the third-party packages
 * whose code the bundle inlined, checked, as `where`.
 * @param {string} where
 * @param {(packages: ThirdParty[]) => void} output
 */
export function bundledLicenses(where, output) {
  return license({
    thirdParty: {
      multipleVersions: true,
      output: (deps) =>
        output(
          deps
            .filter((dep) => !own.has(dep.name))
            .map((dep) => entry(dep, dep.licenseText, dep.noticeText, where)),
        ),
    },
  })
}

const readFirst = (dir, pattern) => {
  const file = readdirSync(dir).find((f) => pattern.test(f))
  return file ? readFileSync(join(dir, file), 'utf8') : null
}

/** A package that's inlined some other way than as a bundled module, from its directory. */
export function packageLicense(dir, where) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  return entry(
    pkg,
    readFirst(dir, /^licen[cs]e(\..*)?$/i),
    readFirst(dir, /^notice(\..*)?$/i),
    where,
  )
}

/** `name`'s package directory, as Node resolves it from `from`, without going through exports. */
export function packageDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) throw new Error(`can't find ${name} from ${from}`)
  }
}

/** The packages a CSS file pulls in with a bare `@import` (Tailwind inlines them). */
export function cssImports(file, where) {
  const css = readFileSync(file, 'utf8')
  return [...css.matchAll(/@import\s+(?:url\()?["']([^./"'][^"']*)["']/g)].map((m) => {
    const spec = /** @type {string} */ (m[1])
    const name = spec
      .split('/')
      .slice(0, spec.startsWith('@') ? 2 : 1)
      .join('/')
    return packageLicense(packageDir(name, dirname(file)), where)
  })
}

/** Files under `dir` whose first line credits `marker`, relative to `base`. */
export function markedFiles(dir, marker, base) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => readFileSync(f, 'utf8').split('\n', 1)[0]?.includes(marker))
    .map((f) => relative(base, f).replaceAll('\\', '/'))
    .sort()
}

/**
 * THIRD_PARTY_NOTICES.md: one section per package and version, where it's inlined, its licence
 * and its notices.
 * @param {string} name The package the notices ship in.
 * @param {ThirdParty[]} packages
 * @param {{ title: string, license: string, licenseText: string, source: string, files: string[], into: string, modified: boolean }[]} copied
 *   Code copied into the workspace's own sources: `into` names what ships it, `modified` whether
 *   the copy was changed.
 */
export function renderNotices(name, packages, copied) {
  const merged = new Map()
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`
    const seen = merged.get(key)
    if (seen) {
      seen.where = [...new Set([...seen.where, ...pkg.where])]
      seen.modified ??= pkg.modified
    } else merged.set(key, { ...pkg, where: [...pkg.where] })
  }
  const sorted = [...merged.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
  const fence = (text) => {
    const ticks = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((t) => t.length + 1)))
    return `${ticks}text\n${text}\n${ticks}`
  }
  const lines = [
    '# Third-party notices',
    '',
    `${name} is licensed under the Apache License 2.0 (see \`LICENSE\`). Its published package`,
    'also contains the third-party code below, inlined at build time, under its own licence.',
    `The packages ${name} lists in \`dependencies\` aren't inlined: npm installs them, each`,
    'with its own licence.',
    '',
    '| Package | Version | Licence | Inlined into |',
    '|---|---|---|---|',
    ...sorted.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.where.join(', ')} |`),
    ...copied.map((c) => `| ${c.title} | | ${c.license} | ${c.files.length} source files |`),
  ]
  for (const p of sorted) {
    lines.push('', `## ${p.name}@${p.version}`, '')
    lines.push(`- Licence: ${p.license}`)
    if (p.source) lines.push(`- Source: ${p.source}`)
    lines.push(`- Inlined into: ${p.where.join(', ')}`)
    if (p.modified) lines.push(`- Modified: ${p.modified}`)
    if (p.licenseText) lines.push('', fence(p.licenseText))
    if (p.noticeText) lines.push('', 'NOTICE:', '', fence(p.noticeText))
  }
  for (const c of copied) {
    lines.push('', `## ${c.title}`, '')
    lines.push(`- Licence: ${c.license}`, `- Source: ${c.source}`)
    lines.push(
      `- Copied${c.modified ? ', then modified,' : ''} into these source files of ${c.into}:`,
    )
    lines.push(...c.files.map((f) => `  - \`${f}\``))
    lines.push('', fence(c.licenseText.trim()))
  }
  return `${lines.join('\n')}\n`
}
