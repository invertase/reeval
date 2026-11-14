// `reeval/view` runs in the hosted studio (in any JavaScript runtime) as well as in the CLI: the studio's
// views must come out the same in each. So nothing it loads may use Node, the filesystem or another
// package: these tests walk its imports, in src/ and in the built dist/, and refuse a `node:` or bare
// import and a Node global. The one exception is zod in the RunReport schema module and the modules
// it loads, which only the `reeval/view/report` subpath reaches; the `reeval/view` root stays zod-free.
// The other is the `@reeval/agents` subpaths in PURE_PACKAGES, which the walk follows into their
// source and holds to the same rules.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { pkgRoot } from './helpers.ts'

/**
 * The modules that may import zod, with every module they load and nothing else: the RunReport
 * schema behind `reeval/view/report`, whose refusals come from `src/contract/shared.ts`.
 */
const ZOD_MODULES = ['src/view/analysis-schema.ts', 'src/view/report/schema.ts']

/** The package subpaths `src/view` may load, each walked from its source as reeval's own module is. */
const PURE_PACKAGES: Record<string, string> = {
  '@reeval/agents/layouts': join(pkgRoot, '../agents/src/catalog/skill-dirs.ts'),
  '@reeval/agents/usage': join(pkgRoot, '../agents/src/usage.ts'),
}

const NODE_GLOBALS = /\b(process|Buffer|require|__dirname|__filename|global|setImmediate)\b\s*[.([]/

/** The code with its comments and the contents of its strings blanked, so neither reads as code. */
function codeOnly(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      out += ' '
    } else if (c === "'" || c === '"' || c === '`') {
      out += c
      i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
      out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

const IMPORT =
  /(?:^|[;}\n])\s*(import|export)\s+(type\s+)?([^'"`;]*?)\s*from\s*(['"])([^'"]+)\4|(?:^|[;}\n])\s*import\s*(['"])([^'"]+)\6|\bimport\(\s*(['"])([^'"]+)\8\s*\)/g

/** A clause that names only types (`{ type A, type B }`) loads nothing once compiled. */
const typesOnly = (clause: string) => {
  const names = clause.trim()
  if (!/^\{[^}]*\}$/.test(names)) return false
  const parts = names
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length > 0 && parts.every((p) => p.startsWith('type '))
}

function resolveImport(from: string, spec: string): string {
  const path = resolve(dirname(from), spec)
  if (existsSync(path) && !path.endsWith('/')) return path
  for (const ext of ['.js', '.ts', '/index.js', '/index.ts']) {
    if (existsSync(path + ext)) return path + ext
  }
  return path
}

/**
 * Every module `entries` load at run time, and each `node:`/bare import or Node global found in one.
 * `zodIn` names the modules (relative to the package) where `zod` may be imported, by them and by
 * every module they load. A module reached both ways is checked both ways.
 */
function walk(
  entries: string[],
  zodIn: readonly string[] = [],
): { files: string[]; problems: string[] } {
  const seen = new Set<string>()
  const problems: string[] = []
  const files = new Set<string>()
  const visit = (file: string, zodOk = false) => {
    const name = relative(pkgRoot, file)
    zodOk ||= zodIn.includes(name)
    const key = `${zodOk}\0${file}`
    if (seen.has(key)) return
    seen.add(key)
    files.add(file)
    // Imports read the raw source: blanking strings would blank their specifiers.
    const src = readFileSync(file, 'utf8')
    const imports = src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
    for (const m of imports.matchAll(IMPORT)) {
      if (m[2] || (m[3] && typesOnly(m[3]))) continue
      const spec = (m[5] ?? m[7] ?? m[9]) as string
      if (spec.startsWith('.')) visit(resolveImport(file, spec), zodOk)
      else if (PURE_PACKAGES[spec]) visit(PURE_PACKAGES[spec], zodOk)
      else if (spec === 'zod' && zodOk) continue
      else problems.push(`${name} imports ${spec}`)
    }
    const code = codeOnly(src)
    const global = code.match(NODE_GLOBALS)
    if (global) problems.push(`${name} uses ${global[1]}`)
    if (/\bimport\.meta\b/.test(code)) problems.push(`${name} uses import.meta`)
  }
  for (const entry of entries) visit(entry)
  return { files: [...files], problems: [...new Set(problems)] }
}

const viewModules = () =>
  readdirSync(join(pkgRoot, 'src/view'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(pkgRoot, 'src/view', f))

test('everything src/view loads runs in any JavaScript runtime: no Node, no packages', () => {
  const { files, problems } = walk(viewModules(), ZOD_MODULES)
  assert.deepEqual(problems, [])
  for (const shared of [
    'src/view/classify.ts',
    'src/history/tool-class.ts',
    '../agents/src/catalog/skill-dirs.ts',
    '../agents/src/usage.ts',
  ]) {
    assert.ok(files.includes(join(pkgRoot, shared)), `${shared} is on the view path`)
  }
  assert.ok(
    !files.includes(join(pkgRoot, 'src/harness/agents.ts')),
    'the harness catalog stays off the view path',
  )
})

test('zod is allowed in the RunReport and analysis schema modules only, and the reeval/view root never loads it', () => {
  assert.deepEqual(walk(viewModules()).problems.sort(), [
    'src/contract/shared.ts imports zod',
    'src/view/analysis-schema.ts imports zod',
    'src/view/report/schema.ts imports zod',
  ])
  const root = walk([join(pkgRoot, 'src/view/index.ts')], ZOD_MODULES)
  assert.deepEqual(root.problems, [])
  for (const zod of [...ZOD_MODULES, 'src/contract/shared.ts']) {
    assert.ok(!root.files.includes(join(pkgRoot, zod)), `reeval/view loads ${zod}`)
  }
})

test('the built reeval/view loads no Node module and no other chunk that does', () => {
  const entry = join(pkgRoot, 'dist/view/index.js')
  assert.ok(existsSync(entry), 'run pnpm build first')
  const { problems } = walk([entry])
  assert.deepEqual(problems, [])
})

test('the walk finds what it refuses', () => {
  const fixture = join(pkgRoot, 'test/fixtures/view-boundary/bad.ts')
  const { problems } = walk([fixture])
  assert.deepEqual(problems.sort(), [
    'test/fixtures/view-boundary/bad.ts imports node:fs',
    'test/fixtures/view-boundary/bad.ts imports zod',
    'test/fixtures/view-boundary/bad.ts uses process',
    'test/fixtures/view-boundary/helper.ts uses import.meta',
  ])
})

test('the zod exception covers the modules it names and no other', () => {
  const fixture = join(pkgRoot, 'test/fixtures/view-boundary/schema.ts')
  assert.deepEqual(walk([fixture], ['test/fixtures/view-boundary/schema.ts']).problems, [])
  assert.deepEqual(walk([fixture], ['src/view/report/schema.ts']).problems, [
    'test/fixtures/view-boundary/schema.ts imports zod',
    'test/fixtures/view-boundary/schema-helper.ts imports zod',
  ])
  const helper = join(pkgRoot, 'test/fixtures/view-boundary/schema-helper.ts')
  assert.deepEqual(walk([helper], ['test/fixtures/view-boundary/schema.ts']).problems, [
    'test/fixtures/view-boundary/schema-helper.ts imports zod',
  ])
  const bad = join(pkgRoot, 'test/fixtures/view-boundary/bad.ts')
  assert.ok(
    walk([bad], ['test/fixtures/view-boundary/schema.ts']).problems.includes(
      'test/fixtures/view-boundary/bad.ts imports zod',
    ),
  )
})
