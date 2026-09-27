// Finding eval files (engine/files.ts) and loading them (engine/loader.ts): TypeScript, ESM and
// CommonJS mixes through jiti, tsconfig checks, and stacks mapped back to the sources.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { filterFiles, findEvalFiles, matchesFilter } from '../src/engine/files.ts'
import {
  checkTsconfig,
  loadEvalFile,
  originalStack,
  stripJsonComments,
  syntaxError,
  TsconfigError,
} from '../src/engine/loader.ts'
import { tempDir } from './helpers.ts'

function tree(files: Record<string, string>): string {
  const root = tempDir('loader')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

describe('findEvalFiles and filterFiles', () => {
  test('globs include minus exclude, dotfiles included, sorted and absolute', async () => {
    const root = tree({
      'evals/b.es.ts': '',
      'evals/a.es.ts': '',
      'evals/.hidden/c.es.ts': '',
      'evals/.history/old.es.ts': '',
      'node_modules/x/evals/d.es.ts': '',
      'other.ts': '',
    })
    const files = await findEvalFiles(
      root,
      ['**/*.es.ts'],
      ['**/node_modules/**', 'evals/.history/**'],
    )
    assert.deepEqual(
      files.map((f) => relative(root, f)),
      ['evals/.hidden/c.es.ts', 'evals/a.es.ts', 'evals/b.es.ts'],
    )
  })

  test('a filter picks files whose path contains it, ignoring case, from the root or the cwd', () => {
    const root = '/p'
    const files = ['/p/evals/Greet.es.ts', '/p/evals/sub/skill.es.ts', '/p/other/x.es.ts']
    assert.deepEqual(filterFiles(files, [], root), files)
    assert.deepEqual(filterFiles(files, ['greet'], root), ['/p/evals/Greet.es.ts'])
    assert.deepEqual(filterFiles(files, ['/p/evals/sub'], root), ['/p/evals/sub/skill.es.ts'])
    assert.deepEqual(filterFiles(files, ['evals/sub/'], root), ['/p/evals/sub/skill.es.ts'])
    assert.deepEqual(filterFiles(files, ['nope', 'x.es'], root), ['/p/other/x.es.ts'])
    const cwd = process.cwd()
    process.chdir(tempDir('cwd'))
    try {
      // Resolved from the current directory, "sub/" is still under the root: /p/<cwd>/sub/.
      assert.deepEqual(filterFiles(['/q/evals/a.es.ts'], ['/q/evals/'], '/q'), ['/q/evals/a.es.ts'])
    } finally {
      process.chdir(cwd)
    }
  })

  test('a name filter matches part of the eval id or cell#n', () => {
    const attempt = { cell: { key: 'fake/-/fake' }, n: 2 }
    assert.equal(matchesFilter({ id: 'evals/a.es.ts › g › x' }, 'g › x'), true)
    assert.equal(matchesFilter({ id: 'evals/a.es.ts › g › x', attempt }, 'fake#2'), true)
    assert.equal(matchesFilter({ id: 'evals/a.es.ts › g › x', attempt }, 'fake#3'), false)
    assert.equal(matchesFilter({ id: 'evals/a.es.ts › x' }, 'fake#1'), false)
  })
})

describe('loadEvalFile', () => {
  test('TypeScript, ESM, CommonJS, JSON, .mts and .cts, extensionless and circular imports, top-level await', async () => {
    const root = tree({
      'evals/main.es.ts': `import { a, fromB } from './circ-a'
import cjs, { named } from './lib.cjs'
import data from './data.json'
import { m } from './mod.mts'
import c from './cmod.cts'
import { createRequire } from 'node:module'
enum Color { Red = 1 }
const req = createRequire(import.meta.url)
const waited = await new Promise((r) => setTimeout(() => r('tla'), 5))
export const out = { a, fromB: fromB(), cjs, named, data, m, c, waited, req: req('./lib.cjs').named, color: Color.Red, url: import.meta.url.startsWith('file:') }
`,
      'evals/circ-a.ts':
        "import { b } from './circ-b'\nexport const a = 'A'\nexport function fromB() { return b() }\n",
      'evals/circ-b.ts':
        "import { a } from './circ-a'\nexport function b() { return 'B sees ' + a }\n",
      'evals/lib.cjs': "module.exports = { named: 'N', kind: 'cjs' }\n",
      'evals/data.json': '{ "k": 1 }\n',
      'evals/mod.mts': "export const m: string = 'mts'\n",
      'evals/cmod.cts':
        "const sync: string = require('./required.ts').value\nexport = 'cts' + sync.length\n",
      'evals/required.ts': "export const value: string = ''\n",
    })
    const loaded = (await loadEvalFile(join(root, 'evals/main.es.ts'), root)) as { out: unknown }
    assert.deepEqual(loaded.out, {
      a: 'A',
      fromB: 'B sees A',
      cjs: { named: 'N', kind: 'cjs' },
      named: 'N',
      data: { k: 1 },
      m: 'mts',
      c: 'cts0',
      waited: 'tla',
      req: 'N',
      color: 1,
      url: true,
    })
  })

  test("tsconfig paths don't resolve, as under Vite: the import fails loudly", async () => {
    const root = tree({
      'tsconfig.json':
        '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/*"] } } }',
      'src/lib.ts': 'export const lib = 1\n',
      'evals/p.es.ts': "import { lib } from '@lib/lib'\nexport { lib }\n",
    })
    await assert.rejects(loadEvalFile(join(root, 'evals/p.es.ts'), root), /@lib\/lib/)
  })

  test('a syntax error names the file and position, with a code frame', async () => {
    const root = tree({ 'evals/bad.es.ts': "const x = 1\nevaluate('f' async () => {})\n" })
    await assert.rejects(loadEvalFile(join(root, 'evals/bad.es.ts'), root), (error: Error) => {
      assert.equal(error.name, 'SyntaxError')
      assert.match(
        error.message,
        /^Unexpected token, expected "," \(evals\/bad\.es\.ts:2:14\)\n {2}1\| const x = 1\n/,
      )
      return true
    })
    // Anything else passes through unchanged.
    await assert.rejects(
      loadEvalFile(join(root, 'evals/missing.es.ts'), root),
      (e: Error) => e.name !== 'SyntaxError',
    )
  })

  test("a missing import reads as Vite's did: which module, imported from where", async () => {
    const root = tree({
      'evals/m.es.ts': "import './nope.ts'\n",
      'evals/throws.es.ts': "throw Object.assign(new Error('odd'), { code: 'MODULE_NOT_FOUND' })\n",
    })
    await assert.rejects(
      loadEvalFile(join(root, 'evals/m.es.ts'), root),
      (e: Error) =>
        e.message === `Cannot find module './nope.ts' imported from ${join(root, 'evals/m.es.ts')}`,
    )
    await assert.rejects(loadEvalFile(join(root, 'evals/throws.es.ts'), root), /^Error: odd$/)
    const other = tree({ 'evals/nothing.es.ts': 'throw undefined\n' })
    await assert.rejects(
      loadEvalFile(join(other, 'evals/nothing.es.ts'), other),
      (e) => e === undefined,
    )
  })

  test('syntaxError reads only jiti parse errors, and still reports one whose file is gone', () => {
    assert.equal(syntaxError(new Error('other'), '/'), undefined)
    assert.equal(syntaxError(undefined, '/'), undefined)
    const gone = syntaxError(new Error('ParseError: Bad  \n /nowhere/x.ts:3:0'), '/nowhere')
    assert.equal(gone?.message, 'Bad (x.ts:3:1)')
  })
})

describe('checkTsconfig', () => {
  test('no tsconfig, or valid JSON with comments and trailing commas, passes', () => {
    checkTsconfig(tree({ 'a/x.ts': '' }), '/')
    const root = tree({
      'tsconfig.json':
        '{\n  // strict\n  "compilerOptions": { "strict": true, /* on */ },\n  "include": ["**/*.ts",],\n}\n',
    })
    checkTsconfig(root, root)
  })

  test('a tsconfig that extends a missing file fails, naming it', () => {
    const root = tree({ 'tsconfig.json': '{ "extends": "../../tsconfig.base.json" }' })
    assert.throws(
      () => checkTsconfig(root, root),
      (e: Error) =>
        e instanceof TsconfigError &&
        e.message === "Failed to load tsconfig '../../tsconfig.base.json': Tsconfig not found",
    )
  })

  test("a tsconfig that isn't JSON fails, naming it and why", () => {
    const root = tree({ 'tsconfig.json': '{ bad json' })
    assert.throws(
      () => checkTsconfig(join(root), root),
      /^TsconfigError: Failed to load tsconfig 'tsconfig\.json': Expected property name/,
    )
  })

  test('any other tsconfig error fails too', () => {
    const root = tree({ 'tsconfig.json': '{ "extends": 5 }' })
    assert.throws(() => checkTsconfig(root, root), /^TsconfigError: Failed to load tsconfig: /)
  })

  test('stripJsonComments leaves strings alone', () => {
    const text = String.raw`{ "a": "x // y", "b": "q\"/*" /* c */, "c": [1,], } // end`
    assert.deepEqual(JSON.parse(stripJsonComments(text)), { a: 'x // y', b: 'q"/*', c: [1] })
    assert.equal(stripJsonComments('1 /* open'), '1  ')
    assert.equal(stripJsonComments('"unterminated'), '"unterminated')
  })
})

describe('originalStack', () => {
  test("frames in files jiti transformed point at the source, calls at the callee's name", async () => {
    const root = tree({
      'evals/helper.ts':
        'type T = { a: number }\nexport function boom(): never {\n  throw new Error("boom")\n}\n',
      'evals/main.ts': `import { boom } from './helper'
export function run(): void {
  const t: { n: number } = { n: 1 }
  void t
  boom()
}
`,
    })
    const { run } = (await loadEvalFile(join(root, 'evals/main.ts'), root)) as { run: () => void }
    let stack = ''
    try {
      run()
    } catch (error) {
      stack = originalStack((error as Error).stack ?? '')
    }
    assert.match(stack, new RegExp(`at boom \\(${join(root, 'evals/helper.ts')}:3:9\\)`))
    assert.match(stack, new RegExp(`at run \\(${join(root, 'evals/main.ts')}:5:3\\)`))
    // Edited since it loaded, down to one line: the position is kept as mapped.
    writeFileSync(join(root, 'evals/helper.ts'), '// gone\n')
    let again = ''
    try {
      run()
    } catch (error) {
      again = originalStack((error as Error).stack ?? '')
    }
    assert.match(again, new RegExp(`at boom \\(${join(root, 'evals/helper.ts')}:3:9\\)`))
  })

  test('other frames, unmapped positions and line 1 are handled', async () => {
    const root = tree({ 'evals/one.ts': 'export const f = () => { throw new Error("x") }\n' })
    const file = join(root, 'evals/one.ts')
    const { f } = (await loadEvalFile(file, root)) as { f: () => void }
    let raw = ''
    try {
      f()
    } catch (error) {
      raw = (error as Error).stack ?? ''
    }
    assert.match(originalStack(raw), new RegExp(`${file}:1:32`))
    assert.equal(originalStack('    at x (/elsewhere.js:1:1)'), '    at x (/elsewhere.js:1:1)')
    assert.equal(originalStack(`    at ${file}:999:1`), `    at ${file}:999:1`)
    assert.equal(originalStack(`    at ${file}:1:3`), `    at ${file}:1:3`, "in jiti's wrapper")
    rmSync(file)
    writeFileSync(file, '')
    assert.match(originalStack(raw), new RegExp(`${file}:1:`), 'a file edited since it loaded')
    rmSync(file)
    assert.throws(() => originalStack(raw), /ENOENT/)
  })
})
