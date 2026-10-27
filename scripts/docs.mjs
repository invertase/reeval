#!/usr/bin/env node
// Keeps the docs.page site (docs.json, docs/) in step with the code.
//
//   pnpm docs:gen          rewrite every generated block in docs/
//   pnpm docs:check        fail if a block is stale or the reference misses something
//   pnpm docs:gen --print  list the blocks; --print <name> prints one
//
// Generated blocks sit between `[//]: # (generated:<name>)` and `[//]: # (/generated:<name>)` in
// the .mdx files; everything outside them is hand-written. The CLI help and the query schema
// come from the built CLI, so run `pnpm build` first. The flags come from src/cli-spec.ts, which
// is why the scripts run node with --experimental-strip-types. README.md is hand-written; this
// script does not write to it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { docsRunsProblems } from './docs-runs-checks.mjs'
import {
  harnessFacts,
  renderLayout,
  renderMatrix,
  renderOpenCodeProviders,
} from './harness-matrix.mjs'

const root = join(import.meta.dirname, '..')
const docsDir = join(root, 'docs')
const src = join(root, 'packages/reeval/src')
const cli = join(root, 'packages/reeval/dist/cli.js')
const check = process.argv.includes('--check')
const problems = []
const read = (path) => readFileSync(path, 'utf8')

if (!existsSync(cli)) {
  console.error('docs: packages/reeval/dist/cli.js is missing. Run pnpm build first.')
  process.exit(1)
}

// ---- Sources -------------------------------------------------------------------------------

const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })

/** The help text split into one section per command, keyed `run`, `studio build`, … */
function helpSections(text) {
  const sections = new Map()
  let current = null
  const lines = text.replace(/\n+$/, '').split('\n')
  const blank = lines.lastIndexOf('')
  for (const [i, line] of lines.entries()) {
    if (i > blank) {
      sections.set('footer', [...(sections.get('footer') ?? []), line])
      continue
    }
    const head = /^ {2}reeval ((?:[a-z]+)(?: build)?)\b/.exec(line)
    if (head) current = head[1]
    else if (!line.startsWith('    ')) current = null
    if (current) sections.set(current, [...(sections.get(current) ?? []), line.slice(2)])
  }
  return sections
}

function querySchema() {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-docs-'))
  try {
    const out = execFileSync(process.execPath, [cli, 'query', '--schema', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A `const NAME = [ 'a', 'b' ]` list from a source file. */
function stringList(file, name) {
  const match = new RegExp(`const ${name}[^=]*= \\[([^\\]]*)\\]`).exec(read(join(src, file)))
  if (!match) throw new Error(`docs: can't find ${name} in ${file}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function exitCodes() {
  const match = /const EXIT = \{([^}]*)\}/.exec(read(join(src, 'cli.ts')))
  return [...match[1].matchAll(/(\w+): (\d+)/g)].map((m) => ({ name: m[1], code: Number(m[2]) }))
}

/** Every command's flags, from the spec `reeval` parses its own arguments from. */
async function cliCommands() {
  const spec = join(src, 'cli-spec.ts')
  if (!existsSync(spec)) return null
  const { COMMANDS } = await import(spec)
  const out = new Map()
  for (const [name, command] of Object.entries(COMMANDS)) {
    if (!command.sub || command.flags?.length) out.set(name, command.flags ?? [])
    for (const [sub, spec] of Object.entries(command.sub ?? {}))
      out.set(`${name} ${sub}`, spec.flags)
  }
  return out
}

/** Set by reeval in its own child processes and never read from the user's shell. */
const INTERNAL_VARIABLES = [
  'REEVAL_BACKGROUND',
  'REEVAL_FAKE_EXEC',
  'REEVAL_PROJECT_ROOT',
  'REEVAL_PYTHON',
  'REEVAL_PYTHON_SDK',
  'REEVAL_RUNNER',
  'REEVAL_RUNNER_TOKEN',
  'REEVAL_RUNNER_PROTOCOL',
]

function reevalVariables() {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) {
        for (const m of read(path).matchAll(/\bREEVAL_[A-Z][A-Z0-9_]*\b/g)) found.add(m[0])
      }
    }
  }
  walk(src)
  found.delete('REEVAL_BASE_ARG') // the constant that holds the name REEVAL_BASE
  found.delete('REEVAL_PYTHON_MODULE') // python -m target, not an env var
  for (const name of INTERNAL_VARIABLES) found.delete(name)
  return [...found].sort()
}

/**
 * The exported object types of a .ts file, with their doc comments: enough to document the
 * record without the TypeScript compiler API (TypeScript 7 has none in JS).
 */
function objectTypes(file) {
  const text = read(file)
  const types = []
  const re = /(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?export type (\w+) = ([^{\n=]*)\{/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = re.lastIndex
    let depth = 1
    let i = start
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
    }
    types.push({
      name: m[2],
      doc: docText(m[1]),
      prefix: m[3].trim(),
      fields: fields(oneFieldPerLine(text.slice(start, i - 1))),
    })
    re.lastIndex = i
  }
  return types
}

/** A one-line body (`{ a: string; b: number }`) as one field per line. */
function oneFieldPerLine(body) {
  if (body.includes('\n')) return body
  let depth = 0
  let out = ''
  for (const ch of body) {
    if ('{[(<'.includes(ch)) depth++
    else if ('}])>'.includes(ch)) depth--
    out += ch === ';' && depth === 0 ? '\n' : ch
  }
  return out
}

function docText(comment) {
  if (!comment) return ''
  return comment
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, '').trim())
    .filter(Boolean)
    .join(' ')
}

/** Top-level fields of an object type body: `/** doc *\/ name?: type`. */
function fields(body) {
  const out = []
  let depth = 0
  let doc = ''
  let current = null
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (depth === 0 && !current) {
      if (trimmed.startsWith('/**')) {
        let comment = trimmed
        while (!comment.includes('*/')) comment += `\n${lines[++i]}`
        doc = docText(comment.replace(/^\/\*\*/, '').replace(/\*\/$/, ''))
        continue
      }
      const field = /^(\w+)(\?)?: (.*)$/.exec(trimmed)
      if (!field) continue
      current = { name: field[1], optional: !!field[2], type: field[3], doc }
      doc = ''
    } else if (current) {
      current.type += ` ${trimmed}`
    }
    for (const ch of trimmed) {
      if ('{[(<'.includes(ch)) depth++
      else if ('}])>'.includes(ch)) depth--
    }
    if (current && depth <= 0) {
      depth = 0
      current.type = current.type
        .replace(/\/\*\*[\s\S]*?\*\//g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/([\w\])'"?}]) (\w+\??: )/g, '$1; $2')
        .replace(/[{[(] /g, (s) => s[0])
        .replace(/ [}\])]/g, (s) => s[1])
        .replace(/[;,]$/, '')
      out.push(current)
      current = null
    }
  }
  return out
}

// ---- Rendering -----------------------------------------------------------------------------

/** Escape MDX-significant characters outside inline code spans. */
function mdxText(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[{}]/g, '\\$&').replace(/</g, '&lt;')))
    .join('')
}

const attr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

const codeBlock = (lines) => ['```text', ...lines, '```'].join('\n')

/**
 * Record fields for features the docs leave out, so they aren't rendered: `field` drops a
 * top-level field, `field[].sub` drops `sub` from the item type of the array `field`.
 */
const EXCLUDED_FIELDS = { EnvironmentRecord: ['plugins', 'skills[].plugin'] }

const nestedField = (sub) => new RegExp(`; ${sub}\\??: [^;}]+`)

/** The excluded field paths of a type that no longer match anything in it. */
function staleExclusions(type) {
  return (EXCLUDED_FIELDS[type.name] ?? []).filter((path) => {
    const [field, sub] = path.split('[].')
    const f = type.fields.find((f) => f.name === field)
    return !f || (sub && !nestedField(sub).test(f.type))
  })
}

function renderType(type) {
  const lines = [`### \`${type.name}\``, '']
  if (type.doc) lines.push(mdxText(type.doc), '')
  if (type.prefix) lines.push(`Also has every field of \`${type.prefix.replace(/ &$/, '')}\`.`, '')
  const excluded = (EXCLUDED_FIELDS[type.name] ?? []).map((path) => path.split('[].'))
  for (const f of type.fields) {
    if (excluded.some(([field, sub]) => field === f.name && !sub)) continue
    const subs = excluded.filter(([field, sub]) => field === f.name && sub).map(([, sub]) => sub)
    const fieldType = subs.reduce((t, sub) => t.replace(nestedField(sub), ''), f.type)
    const opt = f.optional ? ' optional' : ''
    const body = f.doc ? `\n  ${mdxText(f.doc)}\n` : ''
    lines.push(`<Property name="${f.name}" type="${attr(fieldType)}"${opt}>${body}</Property>`, '')
  }
  return lines.join('\n').trimEnd()
}

const RECORD_TYPES = [
  'RunRecord',
  'GitInfo',
  'Stack',
  'RunSummary',
  'SandboxWarning',
  'Cost',
  'EvalEntry',
  'CellRecord',
  'Lift',
  'FamilyRecord',
  'FamilyRate',
  'FamilyLift',
  'FamilyInterval',
  'FamilyEffort',
  'FamilyEffortMetric',
  'FingerprintParts',
  'AttemptRecord',
  'AttemptFiles',
  'ArtifactRef',
  'JudgementRecord',
  'JudgeArtifactRef',
  'JudgeRetry',
  'FileRef',
  'ContextFile',
  'Cell',
  'EnvironmentRecord',
  'EgressRecord',
  'AttemptImage',
  'PhaseTimings',
  'FileChange',
  'McpStartup',
]

/** One-line aliases the record uses, shown as a table of values. */
const RECORD_ALIASES = [
  'Outcome',
  'ErrorKind',
  'TurnStatus',
  'ArtifactLevel',
  'RecordMode',
  'FamilyVerdict',
]

function aliases(files) {
  const found = new Map()
  for (const file of files) {
    for (const m of read(file).matchAll(/^export type (\w+) = ([^{\n]+)$/gm))
      found.set(m[1], m[2].trim())
  }
  return found
}

async function blocks() {
  const out = new Map()
  const sections = helpSections(help)
  for (const [name, lines] of sections)
    out.set(`cli-help:${name.replace(' ', '-')}`, codeBlock(lines))

  const schema = querySchema()
  const table = (type) =>
    [
      '| Name | Columns |',
      '|---|---|',
      ...schema
        .filter((o) => o.type === type)
        .map((o) => `| \`${o.name}\` | ${o.columns.map((c) => `\`${c}\``).join(', ')} |`),
    ].join('\n')
  out.set('query-views', table('view'))
  out.set('query-tables', table('table'))

  out.set(
    'exit-codes',
    [
      '| Code | Name |',
      '|---|---|',
      ...exitCodes().map((e) => `| ${e.code} | \`${e.name}\` |`),
    ].join('\n'),
  )

  const config = stringList('config.ts', 'CONFIG_KEYS')
  const defaults = stringList('config.ts', 'DEFAULTS_KEYS')
  const limit = stringList('config.ts', 'LIMIT_KEYS')
  const known = stringList('options.ts', 'EVAL_OPTION_KEYS')
  const all = [...new Set([...config, ...known])]
  const yes = (list, key) => (list.includes(key) ? '✓' : '')
  out.set(
    'option-keys',
    [
      '| Key | `reeval.config.ts` | Profile `defaults` | Group or eval | Profile `limit` |',
      '|---|---|---|---|---|',
      ...all.map(
        (k) =>
          `| [\`${k}\`](#${k.toLowerCase()}) | ${yes(config, k)} | ${yes(defaults, k)} | ${yes(known, k)} | ${yes(limit, k)} |`,
      ),
    ].join('\n'),
  )

  const typeFiles = [join(src, 'history/types.ts'), join(src, 'types.ts')]
  const types = new Map(typeFiles.flatMap(objectTypes).map((t) => [t.name, t]))
  const aliasMap = aliases(typeFiles)
  for (const name of RECORD_ALIASES) {
    if (!aliasMap.has(name)) problems.push(`record alias ${name} isn't a one-line type any more`)
  }
  out.set(
    'record-values',
    [
      '| Type | Values |',
      '|---|---|',
      ...RECORD_ALIASES.filter((n) => aliasMap.has(n)).map(
        (n) =>
          `| \`${n}\` | ${aliasMap
            .get(n)
            .split(' | ')
            .map((v) => `\`${v}\``)
            .join(', ')} |`,
      ),
    ].join('\n'),
  )
  for (const name of RECORD_TYPES) {
    if (!types.has(name))
      problems.push(`record type ${name} isn't in history/types.ts or types.ts any more`)
  }
  for (const name of Object.keys(EXCLUDED_FIELDS)) {
    const type = types.get(name) ?? { name, fields: [] }
    for (const path of staleExclusions(type))
      problems.push(`record type ${name} has no field ${path} to leave out any more`)
  }
  out.set(
    'record-types',
    RECORD_TYPES.filter((n) => types.has(n))
      .map((n) => renderType(types.get(n)))
      .join('\n\n'),
  )

  const harness = await harnessFacts()
  problems.push(...harness.problems)
  out.set('harness-matrix', renderMatrix(harness.facts, { href: (p) => `/${p}`, text: mdxText }))
  out.set('harness-layout', renderLayout(harness.facts))
  out.set('opencode-providers', renderOpenCodeProviders())
  return out
}

// ---- Files ---------------------------------------------------------------------------------

function mdxFiles(dir = docsDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? mdxFiles(join(dir, e.name))
      : e.name.endsWith('.mdx')
        ? [join(dir, e.name)]
        : [],
  )
}

const generated = await blocks()
const print = process.argv.indexOf('--print')
if (print > 0) {
  console.log(generated.get(process.argv[print + 1]) ?? [...generated.keys()].join('\n'))
  process.exit(0)
}
const used = new Set()
const marker =
  /(\[\/\/\]: # \(generated:([\w:-]+)\))\n(?:[\s\S]*?\n)?(\[\/\/\]: # \(\/generated:\2\))/g

for (const file of mdxFiles()) {
  const text = read(file)
  const next = text.replace(marker, (all, open, name, close) => {
    used.add(name)
    if (!generated.has(name)) {
      problems.push(`${relative(root, file)}: unknown generated block "${name}"`)
      return all
    }
    return `${open}\n\n${generated.get(name)}\n\n${close}`
  })
  if (next !== text) {
    if (check) problems.push(`${relative(root, file)} is out of date: run pnpm docs:gen`)
    else writeFileSync(file, next)
  }
}
for (const name of generated.keys()) {
  if (!used.has(name)) problems.push(`generated block "${name}" isn't used on any page`)
}

// ---- Coverage: things that exist in the code must be named in the reference ------------------

const page = (href) => {
  const file = join(docsDir, `${href}.mdx`)
  return existsSync(file) ? read(file) : ''
}
const mentions = (text, token) => text.includes(token)

const commands = await cliCommands()
const sections = helpSections(help)
const GLOBAL_FLAGS = ['config', 'help', 'version']
if (!commands) problems.push('packages/reeval/src/cli-spec.ts is missing')
for (const [name, flags] of commands ?? []) {
  const section = sections.get(name)
  if (!section) {
    problems.push(`reeval --help has no section for reeval ${name}`)
    continue
  }
  const text = section.join('\n')
  for (const flag of flags) {
    if (!GLOBAL_FLAGS.includes(flag) && !text.includes(`--${flag}`)) {
      problems.push(`reeval --help doesn't list --${flag} under reeval ${name}`)
    }
  }
}

const optionsPage =
  page('reference/options') + page('reference/config') + page('reference/profiles')
for (const key of [
  ...new Set([
    ...stringList('config.ts', 'CONFIG_KEYS'),
    ...stringList('options.ts', 'EVAL_OPTION_KEYS'),
  ]),
]) {
  if (!mentions(optionsPage, `name="${key}"`)) {
    problems.push(
      `option "${key}" has no <Property name="${key}"> on reference/options, config or profiles`,
    )
  }
}
for (const key of [
  ...stringList('config.ts', 'PROFILE_KEYS'),
  ...stringList('config.ts', 'LIMIT_KEYS'),
]) {
  if (!mentions(page('reference/profiles'), `\`${key}\``)) {
    problems.push(`profile key "${key}" isn't on reference/profiles`)
  }
}

const envPage = page('reference/env-vars')
for (const name of reevalVariables()) {
  if (!mentions(envPage, `\`${name}\``))
    problems.push(`${name} is read in src/ but not on reference/env-vars`)
}

/** The values `reeval` exports from its root: the names a user imports from the package. */
function rootValueExports() {
  const text = read(join(src, 'index.ts')).replace(/\/\/.*$/gm, '')
  const names = []
  for (const m of text.matchAll(/^export\s*(?!type\b)\{([^}]*)\}/gm)) {
    for (const item of m[1].split(',')) {
      const name = item.trim()
      if (name && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/).pop())
    }
  }
  return names
}

const apiPage = page('reference/api')
for (const name of rootValueExports()) {
  const heading = new RegExp(`^#{2,3} \`${name.replace(/\W/g, '\\$&')}(\\(\\))?\`$`, 'm')
  if (!heading.test(apiPage)) {
    problems.push(`${name} is exported from src/index.ts but has no entry on reference/api`)
  }
}

const cliPage = page('reference/cli')
for (const { code } of exitCodes()) {
  if (!new RegExp(`\\| ${code} \\|`).test(cliPage))
    problems.push(`exit code ${code} isn't on reference/cli`)
}

// ---- Recipes apply the mechanic they link: a recipe with no run command is only a pointer ----

if (!/\breeval run\b/.test(page('recipes/ci-gate'))) {
  problems.push(
    'docs/recipes/ci-gate.mdx has no `reeval run` command: a recipe that only points at another page is a miss',
  )
}

// ---- Gateway pages -----------------------------------------------------------------------------

const srcFile = (file) => read(join(root, 'packages/reeval/src', file))
const gatewayPages = ['direct', 'vercel', 'openrouter', 'vertex'].map((name) => ({
  file: `integrations/gateways/${name}`,
  text: page(`integrations/gateways/${name}`),
}))

// Only the judge takes `typesafe-ai/*` models; the others refuse them in code, so the page that
// lists what `direct()` calls must not put them in the same sentence.
const evaluationModelRefusals = [
  'analysis/model.ts',
  'capture/index.ts',
  'contract/questions.ts',
].filter((file) => srcFile(file).includes("startsWith('typesafe-ai/')"))
if (evaluationModelRefusals.length === 3) {
  const prose = page('integrations/gateways/direct').replace(/```[\s\S]*?```/g, '')
  for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
    if (
      sentence.includes('typesafe-ai/') &&
      /analysis\.model|captures?\b|questions?\b/.test(sentence) &&
      !/\b(?:refuse|refuses|reject|rejects)\b/.test(sentence)
    ) {
      problems.push(
        `integrations/gateways/direct says the analysis model, captures or questions call typesafe-ai/*, but ${evaluationModelRefusals.join(', ')} refuse it: only the judge takes it`,
      )
    }
  }
}

// The four gateway pages cover the same slots in the same order.
const GATEWAY_SECTIONS = ['Credential', 'Helper', 'Harnesses and models']
for (const { file, text } of gatewayPages) {
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  if (headings.join('|') !== GATEWAY_SECTIONS.join('|')) {
    problems.push(
      `${file} has sections [${headings.join(', ')}]; gateway pages use [${GATEWAY_SECTIONS.join(', ')}] in that order`,
    )
  }
}

// The harness support matrix lives on agents/gateways; the pages beside it link to it.
const HARNESS_NAMES =
  /\b(?:Cursor|Claude Code|Codex|Antigravity|OpenCode|Goose|Grok Build|fx|pi)\b/g
for (const { file, text } of gatewayPages) {
  text.split('\n').forEach((line, i) => {
    const names = new Set(line.match(HARNESS_NAMES))
    if (names.size >= 3) {
      problems.push(
        `${file}:${i + 1} lists ${names.size} harnesses: the matrix of which gateway serves which lives on agents/gateways, so link to it`,
      )
    }
  })
}

// ---- Navigation and the package name --------------------------------------------------------

const config = JSON.parse(read(join(root, 'docs.json')))
const hrefs = []
const walkSidebar = (items) => {
  for (const item of items) {
    if (item.pages) walkSidebar(item.pages)
    if (item.href?.startsWith('/')) hrefs.push(item.href)
  }
}
walkSidebar(config.sidebar)
const fileFor = (href) => {
  const base = join(docsDir, href === '/' ? 'index' : href.slice(1))
  return [`${base}.mdx`, join(base, 'index.mdx')].find(existsSync)
}
for (const href of hrefs) {
  if (!fileFor(href)) problems.push(`sidebar link ${href} has no page under docs/`)
}
const linked = new Set(hrefs.map(fileFor).filter(Boolean))
const pkg = config.variables.pkg
/** The package named where it's installed or imported; the brand and CLI share its name. */
const pkgSpecifier = new RegExp(
  `(?:from |import\\(|require\\()['"]${pkg}(?:/[\\w-]+)?['"]|\\b(?:npm (?:i|install)|pnpm add|yarn add|bun add)\\b[^\\n]*\\s${pkg}(?:@\\S*)?(?=\\s|$)`,
)
for (const file of mdxFiles()) {
  if (!linked.has(file)) problems.push(`${relative(root, file)} isn't in the docs.json sidebar`)
  if (pkgSpecifier.test(read(file))) {
    problems.push(
      `${relative(root, file)} installs or imports ${pkg} by name: use {{ pkg }} so it lives in docs.json`,
    )
  }
}

// ---- Walkthroughs: one home each --------------------------------------------------------------

// `reeval init` writes `analysis.model`, whose missing key is a warning in `reeval doctor`
// (src/init.ts, src/doctor.ts), so a page that shows init and a clean doctor must set the key.
for (const file of mdxFiles()) {
  const text = read(file)
  if (
    /reeval init\b/.test(text) &&
    /^No problems\.$/m.test(text) &&
    !text.includes('GOOGLE_GENERATIVE_AI_API_KEY')
  ) {
    problems.push(
      `${relative(root, file)} shows reeval init and a doctor transcript ending "No problems." without setting GOOGLE_GENERATIVE_AI_API_KEY: init writes analysis.model, so doctor ends "No problems, 1 warning." unless the key is set`,
    )
  }
}

const COPIED_BLOCK_LINES = 15
const COPIED_BLOCK_SHARE = 0.8
// The Introduction shows the evaluation file and its result; Quick start is where the same
// evaluation is set up and run, so the two are meant to share it.
const SHARED_BLOCK_PAGES = ['docs/index.mdx', 'docs/quickstart.mdx']
/** A fenced `ts` block's code lines with blank lines, comments and indentation dropped. */
const codeLines = (code) =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
const tsBlocks = []
for (const file of mdxFiles()) {
  for (const match of read(file).matchAll(/^```ts\b[^\n]*\n([\s\S]*?)^```/gm)) {
    const lines = match[1].replace(/\n$/, '').split('\n')
    if (lines.length > COPIED_BLOCK_LINES) {
      tsBlocks.push({ file: relative(root, file), lines: new Set(codeLines(match[1])) })
    }
  }
}
const copied = new Set()
for (const [i, a] of tsBlocks.entries()) {
  for (const b of tsBlocks.slice(i + 1)) {
    if (a.file === b.file) continue
    if (SHARED_BLOCK_PAGES.includes(a.file) && SHARED_BLOCK_PAGES.includes(b.file)) continue
    const shared = [...a.lines].filter((line) => b.lines.has(line)).length
    if (shared / Math.min(a.lines.size, b.lines.size) >= COPIED_BLOCK_SHARE) {
      copied.add(
        `${a.file} and ${b.file} show the same ts block of more than ${COPIED_BLOCK_LINES} lines: keep it on one page and link to it from the other`,
      )
    }
  }
}
problems.push(...copied)

// ---- docs/runs against the code -----------------------------------------------------------------

problems.push(...docsRunsProblems(root))

if (problems.length) {
  console.error(`docs: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(check ? 'docs: up to date' : `docs: ${used.size} generated blocks written`)
