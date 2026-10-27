// How an attempt's error prints (engine/errors.ts): Vitest's layout, message, diff, stack and
// code frame, from errors as a worker serialized them.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import { codeFrame, comparable, formatError, reevalFrames } from '../src/engine/errors.ts'
import { tempDir } from './helpers.ts'

const root = tempDir('errors')
const file = join(root, 'evals/a.eval.ts')
mkdirSync(join(root, 'evals'), { recursive: true })
writeFileSync(
  file,
  [
    "import { evaluate, expect } from 'reeval'",
    '',
    "evaluate('x', async () => {",
    '\tconst value = 1',
    '  expect(value).toBe(2)',
    '})',
    '//# sourceMappingURL=data:application/json;base64,e30=',
    '',
  ].join('\n'),
)
const pkg = join(root, 'node_modules/reeval')
const hide = reevalFrames(pkg)
const plain = (error: unknown, columns?: number) =>
  stripVTControlCharacters(formatError(error, { root, hide, ...(columns ? { columns } : {}) }))
const stack = (...frames: string[]) => ['Error: x', ...frames.map((f) => `    at ${f}`)].join('\n')

describe('formatError', () => {
  test('message, diff, the stack with a code frame at the first project frame', () => {
    const out = plain({
      name: 'AssertionError',
      message: 'expected 1 to be 2',
      diff: '- Expected\n+ Received\n\n- 2\n+ 1',
      stack: stack(
        `run (${pkg}/dist/index.js:1:1)`,
        `Object.toBe (${root}/node_modules/chai/index.js:3:3)`,
        `load (${root}/node_modules/jiti/dist/jiti.cjs:1:1)`,
        `helper (${root}/node_modules/some-lib/index.js:9:9)`,
        `${file}:5:17`,
        `${join(root, 'evals/gone.ts')}:1:1`,
      ),
    })
    assert.equal(
      out,
      [
        'AssertionError: expected 1 to be 2',
        '',
        '- Expected\n+ Received\n\n- 2\n+ 1',
        '',
        ' ❯ helper node_modules/some-lib/index.js:9:9',
        ' ❯ evals/a.eval.ts:5:17',
        "      3| evaluate('x', async () => {",
        '      4|  const value = 1',
        '      5|   expect(value).toBe(2)',
        '       |                 ^',
        '      6| })',
        ' ❯ evals/gone.ts:1:1',
        '',
      ].join('\n'),
    )
    assert.ok(
      formatError(
        { name: 'E', message: 'm', stack: stack(`${file}:5:3`) },
        { root, hide },
      ).includes('\x1b[36m'),
      'the highlighted frame is colored',
    )
  })

  test("an error's own properties print below its stack; an assertion's don't", () => {
    const out = plain(
      { name: 'Error', message: 'boom', code: 'E_BOOM', stack: stack(`${file}:5:3`) },
      20,
    )
    assert.match(out, /\n⎯{20}\nSerialized Error: \[Object: null prototype\] \{ code: 'E_BOOM' \}$/)
    assert.doesNotMatch(
      plain({ name: 'AssertionError', message: 'no', code: 'x', stack: stack(`${file}:5:3`) }),
      /Serialized Error/,
    )
    const rewritten = plain({ name: 'Error', message: 'odd', stack: { frames: 1 } })
    assert.match(
      rewritten,
      /Serialized Error: \[Object: null prototype\] \{ stack: \{ frames: 1 \} \}/,
    )
    assert.match(plain({ name: 'Error', message: 'm', code: 1 }), /^Error: m\n⎯{80}\n/)
  })

  test('primitives, nameless, messageless and very long errors', () => {
    // As Vitest prints them: a thrown primitive has no name.
    assert.equal(plain('a string\nsecond line'), 'Unknown Error: a string')
    assert.equal(plain(null), 'Unknown Error: null')
    assert.equal(plain({ message: 'no name' }), 'Unknown Error: no name')
    assert.match(plain({ name: 'Weird', message: '' }), /name: 'Weird'/)
    const long = 'x'.repeat(5001)
    assert.equal(
      formatError({ name: 'Big', message: long }, { root, hide }),
      `\x1b[31m\x1b[1mBig\x1b[22m\x1b[39m: ${long}`,
    )
    assert.equal(plain(() => {}).startsWith('Unknown Error'), false)
  })

  test("a code frame, frame or cause the error carries prints as it is; a cause's stack has no frame", () => {
    assert.equal(
      plain({
        name: 'SyntaxError',
        message: 'bad',
        codeFrame: '1| x',
        stack: stack(`${file}:5:3`),
      }),
      `SyntaxError: bad\n1| x\n\n ❯ evals/a.eval.ts:5:3\n      3| evaluate('x', async () => {\n      4|  const value = 1\n      5|   expect(value).toBe(2)\n       |   ^\n      6| })\n`,
    )
    assert.equal(plain({ name: 'E', message: 'm', frame: '> 1 | x' }), 'E: m\n> 1 | x')
    const caused = plain({
      name: 'Error',
      message: 'outer',
      cause: { name: 'TypeError', message: 'inner', stack: stack(`${file}:5:3`) },
    })
    assert.equal(caused, `Error: outer\nCaused by: TypeError: inner\n ❯ evals/a.eval.ts:5:3\n`)
    assert.equal(plain({ name: 'E', message: 'm', cause: 'why' }), 'E: m\nCaused by: why')
    assert.equal(
      plain({ name: 'E', message: 'm', cause: { message: 'plain' } }),
      'E: m\nCaused by: plain',
    )
  })

  test('frames compare with forward slashes, and on Windows in any case', () => {
    assert.equal(comparable('C:\\Reeval\\dist\\x.js', true), 'c:/reeval/dist/x.js')
    assert.equal(comparable('/Es/dist\\x.js', false), '/Es/dist/x.js')
    assert.equal(comparable('/p/x.js'), '/p/x.js')
  })

  test('reevalFrames names src/ and dist/, with or without a trailing separator', () => {
    assert.deepEqual(reevalFrames('/p'), [`/p${sep}src${sep}`, `/p${sep}dist${sep}`])
    assert.deepEqual(reevalFrames(`/p${sep}`), [`/p${sep}src${sep}`, `/p${sep}dist${sep}`])
  })
})

describe('codeFrame', () => {
  const frame = (source: string, line: number, column: number, columns = 80) =>
    stripVTControlCharacters(codeFrame(source, 0, { line, column }, columns))

  test('two lines around the location, truncated to the terminal, source map comments left out', () => {
    assert.equal(
      frame('a\nbb\n\nconst long = 1\n//# sourceMappingURL=x\ne', 4, 7, 15),
      '  2| bb\n  3|\n  4| const lon…\n   |       ^\n  6| e',
    )
  })

  test('CRLF line endings', () => {
    assert.equal(frame('one\r\ntwo\r\nthree', 2, 2), '  1| one\n  2| two\n   |  ^\n  3| three')
  })

  test('a minified line shows no frame; a location past the end clamps to the last line', () => {
    assert.equal(frame(`x\n${'y'.repeat(201)}`, 1, 1), '')
    assert.equal(frame('x', 9, 1), '  1| x\n   | ^')
    assert.equal(stripVTControlCharacters(codeFrame('', 0, { line: 1, column: 5 }, 80)), '')
  })
})
