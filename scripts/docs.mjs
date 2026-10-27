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
import { agentsProblems } from './agents-claims.mjs'
import { anchorProblems } from './docs-anchors.mjs'
import { docsRunsProblems } from './docs-runs-checks.mjs'
import { gatewayLandingProblems } from './gateway-landing-claims.mjs'
import {
  harnessFacts,
  renderLayout,
  renderMatrix,
  renderOpenCodeProviders,
  renderPlugins,
} from './harness-matrix.mjs'
import { recipeProblems } from './recipe-claims.mjs'

const root = join(import.meta.dirname, '..')
const docsDir = join(root, 'docs')
const src = join(root, 'packages/reeval/src')
const pythonSrc = join(root, 'packages/reeval-python/src')
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
  const walkPython = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walkPython(path)
      else if (entry.name.endsWith('.py')) {
        for (const m of read(path).matchAll(/\bREEVAL_[A-Z][A-Z0-9_]*\b/g)) found.add(m[0])
      }
    }
  }
  walkPython(pythonSrc)
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

function renderType(type) {
  const lines = [`### \`${type.name}\``, '']
  if (type.doc) lines.push(mdxText(type.doc), '')
  if (type.prefix) lines.push(`Also has every field of \`${type.prefix.replace(/ &$/, '')}\`.`, '')
  for (const f of type.fields) {
    const opt = f.optional ? ' optional' : ''
    const body = f.doc ? `\n  ${mdxText(f.doc)}\n` : ''
    lines.push(`<Property name="${f.name}" type="${attr(f.type)}"${opt}>${body}</Property>`, '')
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
  'PluginRecord',
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
      '| Key | `reeval.config.ts` | Profile `defaults` | Group or evaluation | Profile `limit` |',
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
  out.set(
    'record-types',
    RECORD_TYPES.filter((n) => types.has(n))
      .map((n) => renderType(types.get(n)))
      .join('\n\n'),
  )

  const harness = await harnessFacts()
  problems.push(...harness.problems)
  out.set('harness-matrix', renderMatrix(harness.facts, { href: (p) => `/${p}` }))
  out.set('harness-layout', renderLayout(harness.facts))
  for (const h of harness.facts) out.set(`harness-plugins:${h.kind}`, renderPlugins(h))
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

// The option-keys table's header says "evaluation" in full, as the prose does.
if (/Group or eval(?!uation)/.test(generated.get('option-keys').split('\n')[0])) {
  problems.push(
    'the option-keys table header says "Group or eval": write "Group or evaluation" (scripts/docs.mjs)',
  )
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

// limit.compare's plan notes are the ones src/options.ts pushes: "<n> pairwise question(s) off" and
// "<n> pairwise question(s) narrowed", never "questions off".
const limitCompare =
  page('reference/profiles').match(/^### `compare`\n([\s\S]*?)(?=^#{1,3} )/m)?.[1] ?? ''
if (!limitCompare) {
  problems.push('docs.mjs cannot find the "### `compare`" section on reference/profiles')
} else if (/(?<!pairwise )questions off \(profile/.test(limitCompare)) {
  problems.push(
    'reference/profiles limit.compare notes "questions off (profile": the plan notes "<n> pairwise question(s) off (profile <name>)" (src/options.ts)',
  )
} else if (!limitCompare.includes('pairwise question') || !limitCompare.includes('narrowed')) {
  problems.push(
    'reference/profiles limit.compare omits the "<n> pairwise question(s) narrowed (profile <name>)" note (src/options.ts)',
  )
}

// limit.compare runs after the cascade, so it tests the resolved compare from any level, and a
// baseline it leaves without variants gates like an eval without compare (gateIf in src/options.ts).
if (limitCompare && /applies when the evaluation sets `compare`/.test(limitCompare)) {
  problems.push(
    'reference/profiles limit.compare says it "applies when the evaluation sets `compare`": it limits the resolved compare, from a group, a profile\'s defaults, the config or the evaluation (src/options.ts)',
  )
}
if (limitCompare && !/baseline gates like an evaluation without `compare`/.test(limitCompare)) {
  problems.push(
    'reference/profiles limit.compare does not say how a baseline left without variants gates: like an evaluation without `compare` (src/options.ts gateIf)',
  )
}

const envPage = page('reference/env-vars')
for (const name of reevalVariables()) {
  if (!mentions(envPage, `\`${name}\``))
    problems.push(`${name} is read in src/ but not on reference/env-vars`)
}

// Every variable the source reads (packages/reeval/src and the Python launcher) has its own
// heading, and REEVAL_PYTHON's entry says what python-runner.ts does: the variable applies first,
// and the unset fallback is `python` on Windows and `python3` elsewhere.
{
  const envSections = new Map(
    envPage
      .split(/^## /m)
      .slice(1)
      .map((s) => [/^`([^`]+)`/.exec(s)?.[1], s]),
  )
  for (const name of new Set([...reevalVariables(), 'REEVAL_PYTHON'])) {
    if (!envSections.has(name))
      problems.push(`${name} has no \`## \` heading on reference/env-vars`)
  }
  const python = envSections.get('REEVAL_PYTHON') ?? ''
  if (/\bneither\b|\bonly when\b/.test(python)) {
    problems.push(
      'REEVAL_PYTHON on reference/env-vars says it applies only when uv and .venv do not; python-runner.ts applies it ahead of both',
    )
  }
  if (!/\bahead of `uv run`/.test(python)) {
    problems.push('REEVAL_PYTHON on reference/env-vars must say it applies ahead of `uv run`')
  }
  if (!/`python3`/.test(python) || !/`python`/.test(python) || !/Windows/.test(python)) {
    problems.push(
      'REEVAL_PYTHON on reference/env-vars must say the unset fallback is `python` on Windows and `python3` elsewhere',
    )
  }
}

// The lead of reference/env-vars says a value outside the allowed list stops the command. It must
// name each variable's accepted values, as src/ui/mode.ts's `pick` calls list them.
{
  const modeSource = read(join(src, 'ui', 'mode.ts'))
  const lead = envPage.split(/^## /m)[0]
  const picks = [
    ...modeSource.matchAll(/env\.(REEVAL_[A-Z_]+)\s*,\s*\[([^\]]*)\]\s*as const/g),
  ].map((m) => ({ name: m[1], values: [...m[2].matchAll(/'([\w-]+)'/g)].map((v) => v[1]) }))
  if (picks.length !== 4) {
    problems.push('docs.mjs cannot find the four enum variables in src/ui/mode.ts')
  }
  if (/\bany other value stops the command\b/.test(lead)) {
    problems.push(
      'reference/env-vars lead says "any other value stops the command" without naming the accepted values of each variable',
    )
  }
  for (const { name, values } of picks) {
    const sentence = lead.split(/(?<=\.)\s/).find((s) => /stops the command/.test(s)) ?? ''
    for (const value of values) {
      if (!sentence.includes(`\`${value}\``) || !sentence.includes(`\`${name}\``)) {
        problems.push(
          `reference/env-vars lead doesn't name \`${value}\` as an accepted value of \`${name}\``,
        )
      }
    }
  }
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

/** The top-level keys of an exported object type in types.ts, one `key?: type` per line. */
function typeKeys(name) {
  const m = new RegExp(`export type ${name} = \\{\\n([\\s\\S]*?)\\n\\}`).exec(
    read(join(src, 'types.ts')),
  )
  if (!m) return null
  return [...m[1].matchAll(/^ {2}(?:readonly )?(\w+)\??:/gm)].map((k) => k[1])
}

const judgeKeys = typeKeys('JudgeOptions')
if (!judgeKeys?.length) {
  problems.push('docs.mjs cannot find the JudgeOptions keys in src/types.ts')
}
for (const key of judgeKeys ?? []) {
  if (!mentions(page('reference/options'), `name="judge.${key}"`)) {
    problems.push(`judge option "${key}" has no entry on reference/options`)
  }
}

/** The environment variables a src/ file reads off an `env` object, as `env.NAME`. */
function readEnvNames(file) {
  return [
    ...new Set([...read(join(src, file)).matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1])),
  ].sort()
}
for (const name of readEnvNames('egress.ts')) {
  if (!mentions(envPage, `\`${name}\``)) {
    problems.push(`${name} is read in src/egress.ts but not on reference/env-vars`)
  }
}

const cliPage = page('reference/cli')
for (const { code } of exitCodes()) {
  if (!new RegExp(`\\| ${code} \\|`).test(cliPage))
    problems.push(`exit code ${code} isn't on reference/cli`)
}

// ---- Recipes link a workflow instead of repeating it ----------------------------------------------

// /runs/ci owns the workflow of a recording profile, a secret, a run and a compare. A recipe that
// links it and still teaches all four steps is a second home for them.
const CI_WORKFLOW_STEPS = [/\bprofile\b/, /\bsecrets?\b/, /\breeval run\b/, /\bcompare\b/i]
for (const file of mdxFiles()) {
  if (!relative(docsDir, file).startsWith('recipes/')) continue
  const prose = read(file).replace(/^---\n[\s\S]*?\n---\n/, '')
  if (/\]\(\/runs\/ci[)#]/.test(prose) && CI_WORKFLOW_STEPS.every((step) => step.test(prose))) {
    problems.push(
      `${relative(root, file)} links /runs/ci and also teaches its workflow (profile, secret, reeval run, compare): keep the applied result here and link CI for the steps`,
    )
  }
}

// The regression rule (which diff words fail the job) is written once, as prose on /runs/ci, and
// the diff words live on /results/compare/past-runs. A decision table that maps diff words to a
// passing or failing job is a second copy of the rule, on the recipe or beside CI's prose.
const hasGateDecisionTable = (text) => /^\|[^\n]*`regressed`[^\n]*\|[^\n]*\bFails\b/m.test(text)
{
  const recipe = page('recipes/ci-gate')
  const linksRule = /\]\(\/(runs\/ci|results\/compare\/past-runs)[)#]/.test(recipe)
  if (hasGateDecisionTable(recipe) && (linksRule || hasGateDecisionTable(page('runs/ci')))) {
    problems.push(
      'docs/recipes/ci-gate.mdx has the regression decision table and also links /runs/ci or /results/compare/past-runs: link the rule instead of repeating it',
    )
  }
}

// ---- Studio and debug pages describe what the code does ------------------------------------------

// `reeval studio build` ends its `built` line with the artifact summary, or the records-only note
// under `--no-artifacts` (src/studio/command.ts); its Reference entry holds both.
const studioCommand = read(join(src, 'studio/command.ts'))
const builtSummaries = [
  ...studioCommand.matchAll(/\$\{artifacts \? '( \([^']+\))' : '( \([^']+\))'\}/g),
]
if (builtSummaries.length === 0) {
  problems.push('docs.mjs cannot find the built line summaries in src/studio/command.ts')
}
const studioBuildEntry =
  page('reference/cli').match(/^## `reeval studio build`\n([\s\S]*?)(?=^## )/m)?.[1] ?? ''
if (!studioBuildEntry) {
  problems.push('docs.mjs cannot find the "## `reeval studio build`" section on reference/cli')
}
for (const withArtifacts of builtSummaries.flatMap((match) => match.slice(1))) {
  if (studioBuildEntry && !studioBuildEntry.includes(withArtifacts.trim())) {
    problems.push(
      `reference/cli's reeval studio build entry omits the built line's summary${withArtifacts} that src/studio/command.ts prints`,
    )
  }
}

// Studio and Debugging keep their one job. Exporting a static site and pruning debug data are the
// reeval studio build and reeval clean entries on reference/cli, so neither page shows them in a
// code block.
for (const [pageName, command] of [
  ['results/studio', 'reeval studio build'],
  ['results/debugging', 'reeval clean'],
]) {
  const blocks = [...page(pageName).matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)]
  if (blocks.some(([, code]) => new RegExp(`\\b${command}\\b`).test(code))) {
    problems.push(
      `docs/${pageName}.mdx has a \`${command}\` code block: link its entry on reference/cli instead`,
    )
  }
}

// Debug data is built per attempt (src/attempt/index.ts, src/debug/attempt.ts), so a run with no
// attempt writes no directory.
if (
  page('results/debugging')
    .split(/\n\n+/)
    .some((paragraph) => /debug\b/i.test(paragraph) && /\bon every run\b/i.test(paragraph))
) {
  problems.push(
    'docs/results/debugging.mdx says a debug directory is written on every run: an attempt writes it, so a run with no attempt writes none',
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

problems.push(...(await import('./gateway-claims.mjs')).gatewayModelProblems(docsDir))
problems.push(...gatewayLandingProblems(docsDir))
problems.push(...recipeProblems(docsDir))

// The Docker and Podman pages are short task pages: a few sections and no option catalog. Each
// option's entry lives on reference/options, which they link to.
const SANDBOX_PAGE_MAX_SECTIONS = 3
for (const name of ['docker', 'podman']) {
  const href = `integrations/sandboxes/${name}`
  const text = page(href).replace(/^```[\s\S]*?^```/gm, '')
  const sections = [...text.matchAll(/^## .+$/gm)].length
  if (sections > SANDBOX_PAGE_MAX_SECTIONS) {
    problems.push(
      `${href} has ${sections} level-2 headings, over ${SANDBOX_PAGE_MAX_SECTIONS}: a task page is a short tutorial, so move option entries to reference/options and link them`,
    )
  }
  if (/<Property\b/.test(text)) {
    problems.push(`${href} has <Property> entries: option entries live on reference/options`)
  }
}

// A harness page is a short tutorial: the key, one factory example and the plugins. The factory's
// field definitions live on reference/options#harness-factory-options.
for (const file of readdirSync(join(docsDir, 'integrations/agents')).filter((f) =>
  f.endsWith('.mdx'),
)) {
  const href = `integrations/agents/${file.replace(/\.mdx$/, '')}`
  const text = page(href).replace(/^```[\s\S]*?^```/gm, '')
  if (/<Property\b/.test(text)) {
    problems.push(
      `${href} has <Property> entries: factory fields live on reference/options#harness-factory-options`,
    )
  }
}

// `composer-2.5` takes no `effort`, so the Cursor example names a model that does (`grok-4.7`)
// instead of a `'<model>'` placeholder.
if (page('integrations/agents/cursor').includes("model: '<model>'")) {
  problems.push(
    "integrations/agents/cursor still has model: '<model>': name a model that takes effort, such as grok-4.7",
  )
}

// Reference entries live on reference/options: the agents landing holds no `<Property>` entry, the
// gateways landing no per-harness gateway table, and the Cursor MCP bullet names the transports and
// fields, not the SDK's class.
if (/<Property\b/.test(page('agents/index'))) {
  problems.push(
    'agents/index has a <Property> entry: id, maxConcurrent, startTimeout and gateway live under "Common harness options" on reference/options',
  )
}
if (page('agents/gateways').includes('| Harness | `vercel()` | `openrouter()` |')) {
  problems.push(
    'agents/gateways has the per-harness vercel() and openrouter() table: it lives under "Gateway support by harness" on reference/options',
  )
}
if (page('reference/options').includes('McpServerConfig')) {
  problems.push(
    "reference/options names McpServerConfig in the Cursor MCP bullet: name the transports and fields, not the Cursor SDK's class",
  )
}

// Every factory `reeval/harness` exports is a row of the "Harness factory options" table or named in
// its lead, so the lead's claims cover every factory.
{
  const harnessSource = readFileSync(join(src, 'harness.ts'), 'utf8')
  const factories = [...harnessSource.matchAll(/^export const (\w+) = /gm)].map((m) => m[1])
  const options = page('reference/options')
  const section = options.match(/^### Harness factory options\n([\s\S]*?)(?=^#{1,3} )/m)?.[1] ?? ''
  const lead = section.slice(0, section.indexOf('\n|'))
  const rows = new Set([...section.matchAll(/^\| `(\w+)\(\)` \|/gm)].map((m) => m[1]))
  for (const name of factories) {
    if (!rows.has(name) && !lead.includes(`\`${name}()\``)) {
      problems.push(
        `reference/options "Harness factory options" has no row for ${name}() and its lead doesn't name it: add a row or name it in the lead`,
      )
    }
  }
}

// The landing's option entries moved to reference/options#docker; the Docker task page no longer
// lists them, so a link back there for them is a stale promise.
{
  const landing = page('integrations/sandboxes/index')
  for (const sentence of landing.replace(/```[\s\S]*?```/g, '').split(/(?<=[.!?])\s+/)) {
    if (
      /`root`|`capabilities`|`maxConcurrent`|every option the factories accept/.test(sentence) &&
      sentence.includes('](/integrations/sandboxes/docker)')
    ) {
      problems.push(
        "integrations/sandboxes links root, capabilities, maxConcurrent or the factories' options to /integrations/sandboxes/docker: those entries live at /reference/options#docker",
      )
    }
  }
}

// Podman runs the same limits through `podman run`, so the docker() introduction names the
// engine's run command rather than `docker run` alone.
for (const sentence of page('reference/options')
  .replace(/```[\s\S]*?```/g, '')
  .split(/(?<=[.!?])\s+/)) {
  if (
    sentence.includes('--memory') &&
    sentence.includes('`docker run`') &&
    !sentence.includes('`podman run`') &&
    !sentence.includes('run command')
  ) {
    problems.push(
      "reference/options passes docker() and podman() limits to `docker run` alone: name the engine's run command, or both docker run and podman run",
    )
  }
}

// `across: 'environment'` pairs every two environments on a harness (variants with each other
// too), not only the baseline with each variant (compare/pairs.ts).
for (const sentence of page('write/questions')
  .replace(/```[\s\S]*?```/g, '')
  .split(/(?<=[.!?])\s+/)) {
  if (
    sentence.includes("across: 'environment'") &&
    /pairs the baseline with each variant/.test(sentence) &&
    !/every two environments/.test(sentence)
  ) {
    problems.push(
      "write/questions says across: 'environment' pairs the baseline with each variant: it pairs every two environments on the same agent, variants with each other included",
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

// ---- Claims that must match the code ----------------------------------------------------------

/** A `ts` block titled with an `examples/` path is that file, so the page can't drift from it; the package-name check below leaves these blocks out, as an example keeps its own imports. */
const exampleBlock = /```ts title="(examples\/[^"\n]+)"\n([\s\S]*?)\n```/g
for (const file of mdxFiles()) {
  for (const [, path, body] of read(file).matchAll(exampleBlock)) {
    const full = join(root, path)
    if (!existsSync(full)) {
      problems.push(`${relative(root, file)}: the snippet titled ${path} names no such file`)
    } else if (read(full).trimEnd() !== body.trimEnd()) {
      problems.push(`${relative(root, file)}: the snippet titled ${path} differs from that file`)
    }
  }
}

const resultsPages = mdxFiles(join(docsDir, 'results'))

/** `reeval history` prints one legend line, so a Results page that prints it prints all of it. */
const historyLegend = /'(✓ pass {2}✗ fail[^'\n]*)'/.exec(read(join(src, 'history/views.ts')))?.[1]
if (!historyLegend) problems.push('history/views.ts no longer holds the history legend line')
for (const file of resultsPages) {
  for (const line of read(file).split('\n')) {
    if (historyLegend && line.startsWith('✓ pass') && line.trimEnd() !== historyLegend) {
      problems.push(
        `${relative(root, file)}: the printed history legend differs from history/views.ts: "${historyLegend}"`,
      )
    }
  }
}

/** `reeval query` syncs changed records; only `--rebuild` rebuilds the database (src/query.ts). */
const queriesPage = join(docsDir, 'results/queries.mdx')
if (
  existsSync(queriesPage) &&
  /rebuilds? the database[^.\n]*every query/i.test(read(queriesPage))
) {
  problems.push(
    'results/queries.mdx says the database rebuilds on every query; only --rebuild rebuilds it',
  )
}

// ---- Environment pages ----------------------------------------------------------------------

/** The helper names `helpersFor` hands an environment callback. */
function environmentHelpers() {
  const body = /export function helpersFor\([^)]*\)[^{]*\{\s*return \{([\s\S]*?)\n {2}\}\n\}/.exec(
    read(join(src, 'environment.ts')),
  )
  if (!body) throw new Error("docs: can't find helpersFor in environment.ts")
  return [...body[1].matchAll(/^ {4}(\w+):/gm)].map((m) => m[1])
}

const environmentsLanding = page('environments/index')
const calledHelpers = /receives((?:[`,\sa-z]|and)*?)\./.exec(environmentsLanding)
if (calledHelpers) {
  const listed = new Set([...calledHelpers[1].matchAll(/`(\w+)`/g)].map((m) => m[1]))
  for (const name of environmentHelpers()) {
    if (!listed.has(name)) {
      problems.push(
        `environments/index lists the environment callback helpers and omits \`${name}\`, which helpersFor in environment.ts passes`,
      )
    }
  }
}

/** A secret without `hosts` is the sandbox's real value (types.ts, options.ts's unbrokeredWarning). */
const keptOnHost =
  /\b(?:keys?|secrets?)\b[^.]*\b(?:stays?|remains?|kept|keeps?)\b[^.]*\bon the host\b/i
for (const href of ['environments/secrets', 'environments/egress']) {
  const prose = page(href).replace(/^```[\s\S]*?^```/gm, '')
  for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
    if (keptOnHost.test(sentence) && !/\bhosts\b/.test(sentence)) {
      problems.push(
        `${href} says a key stays on the host without requiring \`hosts\`: "${sentence.trim().slice(0, 80)}…"`,
      )
    }
  }
}

// ---- Options entries ---------------------------------------------------------------------------

/** One `<Property name="…">` entry of reference/options. */
function optionEntry(text, name) {
  const open = text.indexOf(`<Property name="${name}"`)
  if (open === -1) return undefined
  return text.slice(open, text.indexOf('</Property>', open))
}
const dockerId = optionEntry(optionsPage, 'docker.id')
if (dockerId && /\bbegins? with\b[^.]*`docker`/.test(dockerId) && !/podman/.test(dockerId)) {
  problems.push(
    'reference/options docker.id says the default begins `docker` and does not name `podman`: sandboxId in src/options.ts prefixes the engine, `podman` for podman()',
  )
}
if (dockerId && /Defaults to `docker`/.test(dockerId)) {
  problems.push(
    'reference/options docker.id says the default begins `docker`: sandboxId in src/options.ts prefixes the engine, `podman` for podman()',
  )
}
const minLift = optionEntry(optionsPage, 'compare.minLift')
if (
  minLift &&
  /variant cell fails/.test(minLift) &&
  !/famil(?:y|ies)[^.]*\bpooled lift\b/.test(minLift)
) {
  problems.push(
    "reference/options compare.minLift says a variant cell fails and does not say a family is gated on the family's pooled lift (history/families.ts gates the pooled interval)",
  )
}

// ---- Agents pages ------------------------------------------------------------------------------

problems.push(...(await agentsProblems({ root, docsDir })))

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
problems.push(...anchorProblems({ root, docsDir, variables: config.variables }))
const pkg = config.variables.pkg
/** The package named where it's installed or imported; the brand and CLI share its name. */
const pkgSpecifier = new RegExp(
  `(?:from |import\\(|require\\()['"]${pkg}(?:/[\\w-]+)?['"]|\\b(?:npm (?:i|install)|pnpm add|yarn add|bun add)\\b[^\\n]*\\s${pkg}(?:@\\S*)?(?=\\s|$)`,
)
for (const file of mdxFiles()) {
  if (!linked.has(file)) problems.push(`${relative(root, file)} isn't in the docs.json sidebar`)
  if (pkgSpecifier.test(read(file).replace(exampleBlock, ''))) {
    problems.push(
      `${relative(root, file)} installs or imports ${pkg} by name: use {{ pkg }} so it lives in docs.json`,
    )
  }
}

// ---- Walkthroughs: one home each --------------------------------------------------------------

// `reeval init` writes `analysis.model`, whose missing key is a warning in `reeval doctor`
// (src/init.ts, src/doctor.ts) and skips insights in a run (test/init.test.ts), so a page that
// shows init and a doctor transcript may end "No problems." or "No problems, 1 warning.", and
// must not call the insights key required.
const INSIGHTS_KEY_REQUIRED =
  /\bkeys? (?:for )?the (?:agent )?harness and (?:the )?insights model\b|\bkeys the harness and the insights model need\b|\bGoogle (?:API )?key\b[^\n]{0,40}\brequired\b/i
for (const file of mdxFiles()) {
  const text = read(file)
  if (/reeval init\b/.test(text) && /^No problems(?:, \d+ warnings?)?\.$/m.test(text)) {
    if (INSIGHTS_KEY_REQUIRED.test(text)) {
      problems.push(
        `${relative(root, file)} shows reeval init and calls the insights key required: a run without GOOGLE_GENERATIVE_AI_API_KEY skips insights and doctor ends "No problems, 1 warning.", so say the key turns insights on`,
      )
    }
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

// ---- Glossary terms are defined once ---------------------------------------------------------

// The Glossary is the home for definitions: a page outside docs/reference/ links the entry and
// says what the reader does with the term. A page fails when it repeats the first sentence of an
// entry, or defines a term with a `## ` heading there in a sentence that opens "A/An/The <term>
// is". Only a definition counts: the predicate starts with an article, "one", "what", "how",
// "each" or "every", so "A cell is flaky when" and "The lift is paired by case" pass.
const ABOUT_THE_EXAMPLE = new Set(['docs/quickstart.mdx: The baseline is an unstyled page.'])

const plainMarkdown = (text) =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Each `## ` term of the Glossary with the first sentence of its entry, as plain text. */
function glossaryTerms(text) {
  return text
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [heading, ...rest] = section.split('\n')
      const first =
        rest
          .join('\n')
          .trim()
          .split(/\n\s*\n/)[0] ?? ''
      const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(plainMarkdown(first))?.[0] ?? ''
      return { term: heading.replace(/`/g, '').trim(), sentence }
    })
}

const glossaryAnchor = (term) => `/reference/glossary#${term.toLowerCase().replace(/\s+/g, '-')}`

function glossaryRepeatProblems(glossary, pages) {
  const terms = glossaryTerms(glossary).map((entry) => ({
    ...entry,
    start: new RegExp(
      `^(?:A|An|The) ${entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is\\s+(?:a|an|the|one|what|how|each|every)\\b`,
      'i',
    ),
  }))
  const problems = []
  for (const [name, source] of pages) {
    const prose = source.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^```[\s\S]*?^```/gm, '')
    const sentences = prose
      .split(/\n\s*\n|\n(?=#|\s*[-*\d]+[.)]?\s)/)
      .filter((block) => !block.startsWith('#'))
      .flatMap((block) => plainMarkdown(block).split(/(?<=[.!?])\s+/))
      .map((sentence) => sentence.replace(/^[-*]\s+/, ''))
    for (const { term, sentence, start } of terms) {
      const repeated = sentence && sentences.includes(sentence)
      const defined = sentences.find(
        (candidate) => start.test(candidate) && !ABOUT_THE_EXAMPLE.has(`${name}: ${candidate}`),
      )
      if (repeated || defined) {
        problems.push(
          `${name} defines "${term}" in its own words ("${repeated ? sentence : defined}"): the Glossary owns the definition, so link ${glossaryAnchor(term)} and say what the reader does with it`,
        )
      }
    }
  }
  return problems
}

problems.push(
  ...glossaryRepeatProblems(
    read(join(docsDir, 'reference/glossary.mdx')),
    mdxFiles()
      .filter((file) => !relative(docsDir, file).startsWith('reference/'))
      .map((file) => [relative(root, file), read(file)]),
  ),
)

/** The text outside code fences, with the frontmatter kept. */
const outsideFences = (text) => text.replace(/```[\s\S]*?```/g, '')

// ---- docs/runs against the code -----------------------------------------------------------------

problems.push(...docsRunsProblems(root))

// The values and defaults of every `reeval run` flag live on reference/cli, and the `record` and
// `history` defaults on reference/options: the runs pages keep the task and link them.
for (const file of mdxFiles(join(docsDir, 'runs'))) {
  const text = read(file)
  const flagDefaultTable = outsideFences(text)
    .split('\n')
    .some((line) => /^\|/.test(line) && /\bFlag\b/.test(line) && /\bDefault\b/.test(line))
  if (flagDefaultTable) {
    problems.push(
      `${relative(root, file)} has a table with Flag and Default columns: the flags' values and defaults live on reference/cli, so link it`,
    )
  }
}
const recordingText = read(join(docsDir, 'runs/recording.mdx'))
for (const [, intro] of recordingText.matchAll(/([^\n]+)\n\n```ts[^\n]*\n[^`]*defineConfig\(/g)) {
  if (/\bdefaults?\b/i.test(intro)) {
    problems.push(
      `docs/runs/recording.mdx introduces a config block as the defaults ("${intro}"): the record and history defaults live on reference/options, so link them`,
    )
  }
}

// ---- Write pages ----------------------------------------------------------------------------

/** The body of the `##` section titled `title`, or null when the page has none. */
function sectionBody(text, title) {
  const match = new RegExp(`^## ${title}\\s*$`, 'm').exec(text)
  if (!match) return null
  const rest = text.slice(match.index + match[0].length)
  const next = /^## /m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

const writeDir = join(docsDir, 'write')
const turnsPage = join(writeDir, 'turns.mdx')
if (existsSync(turnsPage)) {
  const sendBody = sectionBody(read(turnsPage), 'Send a prompt')
  if (sendBody !== null && /\bc\.send\(\s*['"`]/.test(sendBody)) {
    problems.push(
      `${relative(root, turnsPage)} has a "Send a prompt" section that shows a first c.send() of a string: /write owns the first send, so Turns starts at the second turn and links there`,
    )
  }
}

const appsPage = join(writeDir, 'apps.mdx')
const browserSource = read(join(src, 'capture/browser.ts'))
const quietMs = /NETWORK_QUIET_MS\s*=\s*(\d+)/.exec(browserSource)?.[1]
if (existsSync(appsPage) && quietMs) {
  const idle = /[^.\n]*'idle'[^.\n]*/.exec(outsideFences(read(appsPage)))?.[0]
  if (
    idle &&
    (/\b(?:no|zero) (?:pending |in-flight |outstanding )?(?:network )?requests\b/i.test(idle) ||
      !idle.includes(`${quietMs} ms`))
  ) {
    problems.push(
      `${relative(root, appsPage)} says 'idle' without the rule in capture/browser.ts: Chromium's networkAlmostIdle, at most two requests in flight for ${quietMs} ms, not no pending requests`,
    )
  }
}

// ---- Image alt text ----------------------------------------------------------------------------

// Vale reads Markdown and skips JSX attributes, so Reeval.Verdict never sees an <Image alt="…">.
// "Verdict" is the code name the reference pages document; every other page says judgment.
const altAttribute = /\balt=(?:"([^"]*)"|'([^']*)')/g
const markdownImage = /!\[([^\]]*)\]\(/g
for (const file of mdxFiles()) {
  const path = relative(root, file).split('\\').join('/')
  if (path.startsWith('docs/reference/')) continue
  const text = outsideFences(read(file))
  const alts = [
    ...[...text.matchAll(altAttribute)].map((m) => m[1] ?? m[2]),
    ...[...text.matchAll(markdownImage)].map((m) => m[1]),
  ]
  for (const alt of alts) {
    const found = /(.{0,30})\b(verdicts?)\b(.{0,20})/i.exec(alt)
    if (found) {
      problems.push(
        `${path} has image alt text with "${found[2]}" ("…${found[1]}${found[2]}${found[3]}…"): write "judgment" outside docs/reference/`,
      )
    }
  }
}

// ---- Facts moved from Cases, Groups and Egress ------------------------------------------------

// planTable (src/plan.ts) drops only the family note for { pool: false }: the other notes still print.
if (/empty `notes` column/.test(page('reference/api'))) {
  problems.push(
    'reference/api EachOptions says a { pool: false } dry-run row has an empty `notes` column: only the family note goes, and the skip, profile, brokered, egress and workspace notes still print (src/plan.ts)',
  )
}

// The cascade says where the run flags act: --runs replaces runs, --tag filters evaluations and
// --concurrency caps parallel attempts (src/cli.ts).
const cascadeText =
  page('reference/options').match(/^## The cascade\n([\s\S]*?)(?=^## )/m)?.[1] ?? ''
if (!cascadeText) {
  problems.push('docs.mjs cannot find the "## The cascade" section on reference/options')
} else if (
  /`--runs`/.test(cascadeText) &&
  !(/`--tag`/.test(cascadeText) && /`--concurrency`/.test(cascadeText))
) {
  problems.push(
    'reference/options The cascade names --runs but not --tag and --concurrency: say that --tag filters evaluations and --concurrency caps parallel attempts (src/cli.ts)',
  )
}

// A paired outcome needs PAIRED_MIN (6) discordant pairs or cases (src/stats.ts); the compare entry says so.
if (!/`insufficient` below six discordant/.test(page('reference/options'))) {
  problems.push(
    'reference/options compare must say a paired outcome is `insufficient` below six discordant pairs or cases (PAIRED_MIN in src/stats.ts)',
  )
}

// DEFAULT_EGRESS_ALLOW's hosts are listed once, on reference/api; the egress option links that entry.
const egressText = page('reference/options').match(/^## `egress`\n([\s\S]*?)(?=^## )/m)?.[1] ?? ''
if (!egressText) {
  problems.push('docs.mjs cannot find the "## `egress`" section on reference/options')
} else if (
  !egressText.includes('(/reference/api#defaultegressallow)') ||
  /holds the package registries|registry\.npmjs\.org|github\.com/.test(egressText)
) {
  problems.push(
    "reference/options egress describes DEFAULT_EGRESS_ALLOW's hosts: link [`DEFAULT_EGRESS_ALLOW`](/reference/api#defaultegressallow), which lists them",
  )
}

// ---- The Evaluate page's names -----------------------------------------------------------------

// The /write page is titled Evaluate in the sidebar and its frontmatter, under the Evaluations
// section. docs.page renders the frontmatter title as the page's one H1, so the body has no H1
// of its own that could drift from it.
{
  const sectionOf = (items, href) => {
    for (const item of items) {
      if (item.href === href) return { section: undefined, item }
      if (item.pages) {
        const found = sectionOf(item.pages, href)
        if (found) return { section: found.section ?? item.group, item: found.item }
      }
    }
    return undefined
  }
  const found = sectionOf(config.sidebar, '/write')
  if (found?.section !== 'Evaluations') {
    problems.push(
      `docs.json: the sidebar section holding /write is "${found?.section}", not "Evaluations"`,
    )
  }
  if (found?.item.title !== 'Evaluate') {
    problems.push(`docs.json: the /write sidebar label is "${found?.item.title}", not "Evaluate"`)
  }
  const writeText = read(join(docsDir, 'write', 'index.mdx'))
  const writeTitle = writeText.match(/^---\n[\s\S]*?^title:\s*"?([^"\n]+)"?\s*$/m)?.[1]
  if (writeTitle !== 'Evaluate') {
    problems.push(`write/index.mdx: the frontmatter title is "${writeTitle}", not "Evaluate"`)
  }
  const writeH1 = outsideFences(writeText).match(/^# .+$/m)?.[0]
  if (writeH1 && writeH1 !== '# Evaluate') {
    problems.push(`write/index.mdx: the page heading is "${writeH1}", not "# Evaluate"`)
  }
}

// ---- Task page length --------------------------------------------------------------------------

// A task page (every page outside docs/reference/) stays at 600 words of prose: a short tutorial
// with the alternatives linked out. The count leaves out the frontmatter, code blocks, generated
// blocks, JSX tags and link addresses, and keeps the words in tables.
const TASK_PAGE_WORDS = 600
const prose = (text) =>
  outsideFences(text)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\[\/\/\]: # \(generated:([\w:-]+)\)[\s\S]*?\[\/\/\]: # \(\/generated:\1\)/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
const wordCount = (text) => text.split(/\s+/).filter(Boolean).length
for (const file of mdxFiles()) {
  const path = relative(root, file).split('\\').join('/')
  if (path.startsWith('docs/reference/')) continue
  // The Introduction is the landing page, not a task page.
  if (path === 'docs/index.mdx') continue
  const words = wordCount(prose(read(file)))
  if (words > TASK_PAGE_WORDS) {
    problems.push(
      `${path} has ${words} words of prose: a task page stays at ${TASK_PAGE_WORDS}, so cut it to the tutorial and link the alternatives`,
    )
  }
}

if (problems.length) {
  console.error(`docs: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(check ? 'docs: up to date' : `docs: ${used.size} generated blocks written`)
