// The SDK wire-type generator (scripts/sdk-types.ts): what each schema construct becomes in
// Python and Go, that its output doesn't depend on the host, and that a construct it can't map fails it
// instead of weakening the type.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { definitions, GO_OUT, go, PYTHON_OUT, python, type Schema } from '../scripts/sdk-types.ts'

const generate = (defs: Record<string, Schema>) => python(definitions([defs]))

test('a record with an empty properties map is a dict, not an empty TypedDict', () => {
  const out = generate({
    Json: {
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { $ref: '#/$defs/Json' } },
        {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: { $ref: '#/$defs/Json' },
        },
      ],
    },
    Options: {
      type: 'object',
      properties: {
        providers: {
          type: 'object',
          properties: {},
          additionalProperties: { type: 'object', additionalProperties: {} },
        },
      },
    },
  })
  assert.match(out, /Json: TypeAlias = "str \| list\[Json\] \| dict\[str, Json\]"/)
  assert.match(out, /providers: NotRequired\[dict\[str, dict\[str, Any\]\]\]/)
  assert.doesNotMatch(out, /pass$/m)
})

test('defs are sorted by code point, whatever the locale', () => {
  const out = generate({ Ab: { type: 'string' }, Aa: { type: 'string' }, AB: { type: 'string' } })
  const order = [...out.matchAll(/^(\w+): TypeAlias/gm)].map((m) => m[1])
  assert.deepEqual(order, ['AB', 'Aa', 'Ab'])
})

test('nullable, optional, keyword-named and discriminated fields', () => {
  const out = generate({
    Call: {
      anyOf: [
        {
          type: 'object',
          properties: { op: { const: 'exec' }, command: { type: ['string', 'null'] } },
          required: ['op', 'command'],
        },
        {
          type: 'object',
          properties: { op: { const: 'expect' }, not: { type: 'boolean' } },
          required: ['op'],
        },
      ],
    },
  })
  assert.match(
    out,
    /class CallExec\(TypedDict\):\n {4}op: Literal\["exec"\]\n {4}command: str \| None/,
  )
  assert.match(
    out,
    /CallExpect = TypedDict\(\n {4}"CallExpect",[\s\S]*"not": "NotRequired\[bool\]"/,
  )
  assert.match(out, /Call: TypeAlias = "CallExec \| CallExpect"/)
})

test('a construct the generator cannot map fails it', () => {
  const refused: [string, Record<string, Schema>, RegExp][] = [
    ['allOf', { A: { allOf: [{ type: 'string' }] } as Schema }, /can't map the keyword allOf/],
    ['not', { A: { type: 'object', properties: { x: { not: {} } as Schema } } }, /keyword not/],
    ['an unknown type', { A: { type: 'bigint' } }, /can't map the type bigint/],
    ['a $ref to another file', { A: { $ref: 'other.json#/$defs/B' } }, /can't resolve \$ref/],
    ['a $ref to a missing def', { A: { $ref: '#/$defs/B' } }, /can't resolve \$ref/],
    ['a dotted def name', { 'Foo.Bar': { type: 'string' } }, /can't be a Python name/],
    ['a builtin def name', { str: { type: 'integer' } }, /can't be a Python name/],
    ['a typing def name', { Any: { type: 'integer' } }, /can't be a Python name/],
    ['a keyword def name', { None: { type: 'integer' } }, /can't be a Python name/],
    ['a float literal', { A: { const: 1.5 } }, /no Python Literal for 1.5/],
    ['an array literal', { A: { enum: ['a', []] } }, /no Python Literal for \[\]/],
    [
      'fields beside typed other keys',
      {
        A: {
          type: 'object',
          properties: { x: { type: 'string' } },
          additionalProperties: { type: 'number' },
        },
      },
      /both fields and other keys/,
    ],
    [
      'a variant name that is also a def',
      {
        Call: {
          anyOf: [
            { type: 'object', properties: { op: { const: 'exec' } }, required: ['op'] },
            { type: 'object', properties: { op: { const: 'judge' } }, required: ['op'] },
          ],
        },
        CallExec: { type: 'string' },
      },
      /CallExec is also a \$def/,
    ],
  ]
  for (const [what, defs, error] of refused) {
    assert.throws(() => generate(defs), error, what)
  }
})

test('one def name with two shapes across the sources fails it', () => {
  assert.throws(
    () => definitions([{ A: { type: 'string' } }, { A: { type: 'integer' } }]),
    /\$defs\/A differs between the schemas/,
  )
})

test('the checked-in _wire.py is the generator output, and imports', (t) => {
  const out = python()
  assert.equal(readFileSync(PYTHON_OUT, 'utf8'), out, 'run pnpm --filter reeval sdk-types')
  const version = spawnSync('python3', ['-c', 'import sys; sys.exit(sys.version_info < (3, 11))'])
  if (version.status !== 0) return t.skip('no Python 3.11 or later on PATH')
  const dir = mkdtempSync(join(tmpdir(), 'reeval-sdk-types-'))
  writeFileSync(join(dir, 'wire.py'), out)
  const imported = spawnSync('python3', ['-c', 'import wire'], { cwd: dir, encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
})

test("the output is the same with Windows' path module", () => {
  const generator = new URL('../scripts/sdk-types.ts', import.meta.url).href
  const dir = mkdtempSync(join(tmpdir(), 'reeval-sdk-types-win32-'))
  writeFileSync(
    join(dir, 'hooks.mjs'),
    `export async function resolve(specifier, context, next) {
  if (context.parentURL === ${JSON.stringify(generator)} && /^(node:)?path$/.test(specifier)) {
    return { url: 'node:path/win32', shortCircuit: true }
  }
  return next(specifier, context)
}\n`,
  )
  writeFileSync(
    join(dir, 'register.mjs'),
    `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)})\n`,
  )
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      pathToFileURL(join(dir, 'register.mjs')).href,
      '--input-type=module',
      '-e',
      `const { python } = await import(${JSON.stringify(generator)}); process.stdout.write(python())`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, python())
})

test("the key tables name reeval's camelCase keys and the fields that are records", () => {
  const out = generate({
    Options: {
      type: 'object',
      properties: {
        minLift: { type: 'number' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        mcp: { anyOf: [{ type: 'string' }, { type: 'object', properties: {} }] },
        sandbox: { type: 'object', properties: { startTimeout: { type: 'string' } } },
      },
    },
  })
  assert.match(
    out,
    /CAMEL_KEYS: frozenset\[str\] = frozenset\(\n {4}\{\n {8}"minLift",\n {8}"startTimeout",\n {4}\}\n\)/,
  )
  assert.match(
    out,
    /RECORD_FIELDS: frozenset\[str\] = frozenset\(\n {4}\{\n {8}"env",\n {8}"mcp",\n {4}\}\n\)/,
  )
})

const generateGo = (defs: Record<string, Schema>) => go(definitions([defs]))

test('Go: constants marshal from MarshalJSON, optional structs are pointers, enums are consts', () => {
  const out = generateGo({
    Call: {
      anyOf: [
        {
          type: 'object',
          properties: {
            op: { const: 'exec' },
            command: { type: 'string' },
            background: { type: 'boolean' },
            result: { $ref: '#/$defs/Result' },
          },
          required: ['op', 'command'],
        },
        { type: 'object', properties: { op: { const: 'kill' } }, required: ['op'] },
      ],
    },
    Result: {
      type: 'object',
      properties: { exitCode: { type: 'integer' } },
      required: ['exitCode'],
    },
    Mode: { enum: ['run', 'skip'] },
  })
  assert.match(out, /type CallExec struct \{[^}]*Background bool +`json:"background,omitzero"`/)
  assert.match(out, /Command +string +`json:"command"`/)
  assert.match(out, /Result +\*Result +`json:"result,omitzero"`/)
  assert.match(out, /Op string `json:"op"`\n\t\tfields\n\t\}\{"exec", fields\(v\)\}/)
  assert.match(out, /type Call interface \{\n\tisCall\(\)\n\}/)
  assert.match(out, /func \(CallKill\) isCall\(\) \{\}/)
  assert.match(
    out,
    /type Mode string\n\nconst \(\n\tModeRun +Mode = "run"\n\tModeSkip +Mode = "skip"\n\)/,
  )
})

test("Go: a def name that isn't an exported identifier fails it", () => {
  assert.throws(() => generateGo({ lower: { type: 'string' } }), /lower/)
})

test('the checked-in wire_gen.go is the generator output, and vets', (t) => {
  const out = go()
  assert.equal(readFileSync(GO_OUT, 'utf8'), out, 'run pnpm --filter reeval sdk-types')
  const gofmt = spawnSync('gofmt', ['-l', GO_OUT], { encoding: 'utf8' })
  if (gofmt.error) return t.skip('no Go on PATH')
  assert.equal(gofmt.stdout, '', 'gofmt would change wire_gen.go')
  const vet = spawnSync('go', ['vet', './internal/wire'], {
    cwd: join(GO_OUT, '..', '..', '..'),
    encoding: 'utf8',
  })
  assert.equal(vet.status, 0, vet.stderr)
})
