// A session's out directory: every file written, the credentials masked in each, a directory that
// reads part-way through, and each line fitting its snapshot in schema/.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { local } from '../src/local.ts'
import { OUTPUT_CAP } from '../src/out/index.ts'
import { agent } from '../src/session.ts'
import { AGENTS_VERSION } from '../src/version.ts'
import { reply, scripted } from './scripted.ts'

const KEY = 'sk-cursor-0123456789abcdef'

let dir: string
let out: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agents-out-'))
  out = join(dir, 'out')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const text = (file: string) => readFile(join(out, file), 'utf8')
const lines = async (file: string) =>
  (await text(file))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

type Schema = {
  $ref?: string
  type?: string | string[]
  const?: unknown
  enum?: unknown[]
  anyOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: Schema
}
type Doc = Schema & { $defs: Record<string, Schema> }

const typeOf = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v

/** Where `value` doesn't fit `schema`: the subset of JSON Schema the snapshots use. */
function misfits(doc: Doc, schema: Schema, value: unknown, at = '$'): string[] {
  if (schema.$ref)
    return misfits(doc, doc.$defs[schema.$ref.replace('#/$defs/', '')] ?? {}, value, at)
  if (schema.anyOf) {
    return schema.anyOf.some((s) => misfits(doc, s, value, at).length === 0)
      ? []
      : [`${at}: fits no variant`]
  }
  if ('const' in schema && value !== schema.const) return [`${at}: isn't ${schema.const}`]
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${value} isn't listed`]
  if (schema.type) {
    const types = [schema.type].flat()
    const t = typeOf(value)
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) {
      return [`${at}: a ${t}, not ${types.join(' or ')}`]
    }
  }
  if (Array.isArray(value) && schema.items) {
    return value.flatMap((v, i) => misfits(doc, schema.items as Schema, v, `${at}[${i}]`))
  }
  if (typeOf(value) !== 'object') return []
  const object = value as Record<string, unknown>
  return [
    ...(schema.required ?? []).filter((k) => !(k in object)).map((k) => `${at}.${k}: missing`),
    ...Object.entries(object).flatMap(([k, v]) => {
      const property = schema.properties?.[k] ?? schema.additionalProperties
      return property ? misfits(doc, property, v, `${at}.${k}`) : []
    }),
  ]
}

async function fits(name: string, value: unknown) {
  const url = new URL(`../schema/${name}.schema.json`, import.meta.url)
  const doc = JSON.parse(await readFile(url, 'utf8')) as Doc
  assert.deepEqual(misfits(doc, doc, value), [], `${name}: ${JSON.stringify(value).slice(0, 200)}`)
}

const shell = (output: string): HarnessV1StreamPart[] =>
  [
    { type: 'tool-call', toolCallId: 'c1', toolName: 'shell', input: '{"command":"env"}' },
    { type: 'tool-result', toolCallId: 'c1', toolName: 'shell', result: { output } },
  ] as HarnessV1StreamPart[]

test('every file is written, with the key masked in each', async () => {
  const script = scripted([
    reply(`the key is ${KEY}`, shell(`CURSOR_API_KEY=${KEY}`)),
    reply('two'),
  ])
  const session = await agent({
    harness: { ...script.harness, effort: 'high' },
    runner: local({ cwd: dir }),
    credentials: { CURSOR_API_KEY: KEY },
    out: { dir: out, raw: true, debug: true },
  }).start()
  const first = await session.send(`use ${KEY}`).result
  assert.ok(first.text.includes(KEY), 'the result itself is the caller’s, unmasked')
  await session.send('two').result
  await session.close()

  for (const file of [
    'session.json',
    'turns.jsonl',
    'transcript.jsonl',
    'raw/parts.jsonl',
    'debug.log',
  ]) {
    const body = await text(file)
    assert.ok(body.length > 0, `${file} is empty`)
    assert.ok(!body.includes(KEY), `${file} has the key`)
  }
  assert.match(await text('transcript.jsonl'), /CURSOR_API_KEY=\[masked\]/)

  const doc = JSON.parse(await text('session.json'))
  assert.equal(doc.schemaVersion, 1)
  assert.equal(doc.agentsVersion, AGENTS_VERSION)
  assert.deepEqual(doc.harness, { kind: 'cursor', model: 'composer-test', effort: 'high' })
  assert.deepEqual(doc.adapter, { name: 'scripted' })
  assert.equal(doc.status, 'closed')
  assert.equal(doc.runner.cwd, dir)
  assert.ok(doc.endedAt >= doc.startedAt)
  assert.deepEqual(Object.keys(doc.phases).sort(), ['bootstrap', 'place', 'runner'])
  await fits('session', doc)

  const turns = await lines('turns.jsonl')
  assert.deepEqual(
    turns.map((t) => [t.turn, t.prompt, t.text]),
    [
      [0, 'use [masked]', 'the key is [masked]'],
      [1, 'two', 'two'],
    ],
  )
  for (const t of turns) {
    assert.ok(!('transcript' in t) && !('raw' in t) && !('steps' in t))
    await fits('turn', t)
  }
  const transcript = await lines('transcript.jsonl')
  assert.deepEqual([...new Set(transcript.map((l) => l.turn))], [0, 1])
  assert.ok(transcript.some((l) => l.type === 'tool'))
  for (const l of transcript) await fits('transcript-line', l)
  const parts = await lines('raw/parts.jsonl')
  assert.ok(parts.some((p) => p.turn === 1 && (p.part as { type: string }).type === 'finish'))
})

test('a directory reads part-way through: the session running, each ended turn in place', async () => {
  const script = scripted([reply('one')])
  const session = await agent({
    harness: script.harness,
    runner: local({ cwd: dir }),
    out,
  }).start()
  assert.equal(JSON.parse(await text('session.json')).status, 'running')
  await session.send('one').result
  const doc = JSON.parse(await text('session.json'))
  assert.equal(doc.status, 'running')
  assert.equal(doc.endedAt, undefined)
  await fits('session', doc)
  assert.equal((await lines('turns.jsonl')).length, 1)
  assert.ok((await lines('transcript.jsonl')).length > 0)
  await assert.rejects(text('debug.log'), { code: 'ENOENT' })
  await session.close()
})

test("a tool's output past the cap is cut to its ends, with its whole size", async () => {
  const long = `${'a'.repeat(OUTPUT_CAP)}${KEY}tail`
  const session = await agent({
    harness: scripted([reply('done', shell(long))]).harness,
    runner: local({ cwd: dir }),
    credentials: { CURSOR_API_KEY: KEY },
    out,
  }).start()
  await session.send('go').result
  await session.close()
  const tool = (await lines('transcript.jsonl')).find((l) => l.type === 'tool') as {
    output: string
    outputTruncated: { bytes: number }
  }
  assert.ok(tool.output.length < OUTPUT_CAP)
  assert.match(tool.output, /\[truncated \d+ of \d+ characters, sha256 [0-9a-f]{64}\]/)
  assert.ok(tool.output.includes('[masked]tail'))
  assert.ok(tool.outputTruncated.bytes > OUTPUT_CAP)
  await fits('transcript-line', tool)
})

test('a session that fails to start is recorded failed, with why', async () => {
  const a = agent({
    harness: scripted([], new Error(`refused ${KEY}`)).harness,
    runner: local({ cwd: dir }),
    credentials: { CURSOR_API_KEY: KEY },
    out,
  })
  await assert.rejects(a.start())
  const doc = JSON.parse(await text('session.json'))
  assert.equal(doc.status, 'failed')
  assert.match(doc.error, /Cursor harness failed to start: refused \[masked\]/)
  assert.ok(doc.endedAt)
  await fits('session', doc)
})

test("AGENTS_VERSION is the package's version", async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(AGENTS_VERSION, pkg.version)
})

test('a key split across deltas is masked in raw/parts.jsonl', async () => {
  const half = KEY.length / 2
  const split = [
    { type: 'stream-start' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: `the key is ${KEY.slice(0, half)}` },
    { type: 'text-delta', id: 't', delta: KEY.slice(half, half + 3) },
    { type: 'text-delta', id: 't', delta: `${KEY.slice(half + 3)}!` },
    { type: 'text-end', id: 't' },
    ...reply('').slice(-2),
  ] as HarnessV1StreamPart[]
  const session = await agent({
    harness: scripted([split]).harness,
    runner: local({ cwd: dir }),
    credentials: { CURSOR_API_KEY: KEY },
    out: { dir: out, raw: true },
  }).start()
  await session.send('go').result
  await session.close()
  const body = await text('raw/parts.jsonl')
  for (const piece of [KEY.slice(0, half), KEY.slice(half + 3)]) {
    assert.ok(!body.includes(piece), 'a piece of the key is left')
  }
  const deltas = (await lines('raw/parts.jsonl'))
    .map((l) => l.part as { type: string; text?: string; delta?: string })
    .filter((p) => p.type === 'text-delta')
  assert.equal(deltas.map((p) => p.text ?? p.delta).join(''), 'the key is [masked]!')
})

test('a secret that starts another leaves none of the longer one', async () => {
  const prefix = KEY.slice(0, 10)
  const session = await agent({
    harness: scripted([reply(`key ${KEY} and ${prefix}`)]).harness,
    runner: local({ cwd: dir }),
    credentials: { SHORT: prefix, CURSOR_API_KEY: KEY },
    out,
  }).start()
  await session.send('go').result
  await session.close()
  for (const file of ['turns.jsonl', 'transcript.jsonl']) {
    const body = await text(file)
    assert.ok(!body.includes(KEY.slice(10)), `${file} has the rest of the key`)
    assert.match(body, /key \[masked\] and \[masked\]/)
  }
})

/** `key` streamed in `pieces` after "key ", each delta followed by its native event as `raw(delta)`. */
function streamed(
  id: string,
  type: 'text' | 'reasoning',
  pieces: readonly string[],
  raw: (delta: string, soFar: string) => unknown,
) {
  const deltas = ['key ', ...pieces, '!']
  let soFar = ''
  return [
    { type: `${type}-start`, id },
    ...deltas.flatMap((delta) => {
      soFar += delta
      return [
        { type: `${type}-delta`, id, delta },
        { type: 'raw', rawValue: raw(delta, soFar) },
      ]
    }),
    { type: `${type}-end`, id },
  ]
}

const chunks = (key: string, sizes: readonly number[]) => {
  const out: string[] = []
  for (let at = 0, i = 0; at < key.length; at += sizes[i++ % sizes.length]) {
    out.push(key.slice(at, at + sizes[i % sizes.length]))
  }
  return out
}

/** The turn's raw parts, each line parsed, with `key` as the session's credential. */
async function rawOf(key: string, turn: unknown[]) {
  const session = await agent({
    harness: scripted([
      [{ type: 'stream-start' }, ...turn, ...reply('').slice(-2)] as HarnessV1StreamPart[],
    ]).harness,
    runner: local({ cwd: dir }),
    credentials: { CURSOR_API_KEY: key },
    out: { dir: out, raw: true },
  }).start()
  await session.send('go').result
  await session.close()
  const body = await text('raw/parts.jsonl')
  const parsed = body
    .trim()
    .split('\n')
    .map(
      (l) =>
        JSON.parse(l) as {
          part: { type: string; delta?: string; text?: string; rawValue?: unknown }
        },
    )
  return { body, parts: parsed.map((l) => l.part) }
}

/** Every string in `value` that isn't under a `type` key, joined. */
const strings = (value: unknown, key?: string): string =>
  typeof value === 'string'
    ? key === 'type'
      ? ''
      : value
    : Array.isArray(value)
      ? value.map((v) => strings(v)).join('')
      : value && typeof value === 'object'
        ? Object.entries(value)
            .map(([k, v]) => strings(v, k))
            .join('')
        : ''

/** No piece of `key` is in a raw part's strings, joined in order, and the deltas read masked. */
function assertMasked(
  key: string,
  parts: Array<{ type: string; delta?: string; text?: string; rawValue?: unknown }>,
) {
  const raw = parts.filter((p) => p.type === 'raw').map((p) => strings(p.rawValue))
  for (const leak of [key, key.slice(0, 8), key.slice(-8)]) {
    assert.ok(!raw.join('').includes(leak), 'the raw parts rebuild part of the key')
  }
  for (const type of ['text-delta', 'reasoning-delta']) {
    const deltas = parts.filter((p) => p.type === type)
    if (deltas.length) assert.equal(deltas.map((p) => p.text ?? p.delta).join(''), 'key [masked]!')
  }
}

const piEvent = (kind: string) => (delta: string) => ({
  type: 'message_update',
  usage: { input: 1640, output: 98, totalTokens: 1738, cost: { total: 0.0015975 } },
  assistantMessageEvent: { type: kind, contentIndex: 0, delta },
})

test("a key pi streams a token or three at a time is masked in each token's raw part", async () => {
  const key = 'sk-pro-beZYXW-9f3k2Lq8mN4tRvA1x'
  for (const sizes of [[1], [2], [3], [2, 4, 2, 3, 1]]) {
    const { parts } = await rawOf(key, [
      ...streamed('reasoning-0', 'reasoning', chunks(key, sizes), piEvent('thinking_delta')),
      ...streamed('text-0', 'text', chunks(key, sizes), piEvent('text_delta')),
    ])
    assertMasked(key, parts)
    const raw = parts.filter((p) => p.type === 'raw') as Array<{ rawValue: { usage: unknown } }>
    for (const r of raw) assert.deepEqual(r.rawValue.usage, piEvent('')('').usage)
  }
})

test('a digit piece of a key leaves numbers alone and every raw line valid JSON', async () => {
  const key = 'sk-abc-1738-xyz-0015975'
  const { body, parts } = await rawOf(key, [
    ...streamed('text-0', 'text', ['sk-abc-', '1738', '-xyz-', '0015975'], piEvent('text_delta')),
  ])
  assertMasked(key, parts)
  assert.match(body, /"totalTokens":1738/)
  assert.match(body, /"total":0\.0015975/)
})

test("a common-word piece of a key leaves the native event's type and other text alone", async () => {
  const key = 'sk-text-Q9w8E7r6'
  const cursor = (delta: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: delta }] },
  })
  const { parts } = await rawOf(key, [
    ...streamed('text-1', 'text', ['sk-', 'text', '-Q9w8', 'E7r6'], cursor),
    { type: 'raw', rawValue: { type: 'system', note: 'plain text here' } },
  ])
  assertMasked(key, parts)
  const raw = parts.filter((p) => p.type === 'raw') as Array<{
    rawValue: { message: { content: Array<{ type: string }> }; note?: string }
  }>
  for (const r of raw.slice(0, -1)) assert.equal(r.rawValue.message.content[0].type, 'text')
  assert.equal(raw.at(-1)?.rawValue.note, 'plain text here')
})

test('a raw part that repeats the text so far, or covers two deltas, is masked too', async () => {
  const key = 'sk-cursor-0123456789abcdef'
  const pieces = chunks(key, [5, 3])
  const codex = await rawOf(key, [
    ...streamed('text-0', 'text', pieces, (_, soFar) => ({
      type: 'item.updated',
      item: { id: 'item_0', type: 'agent_message', text: soFar },
    })),
  ])
  assertMasked(key, codex.parts)
  assert.ok(codex.parts.some((p) => strings(p.rawValue) === 'item_0key [masked]!'))
  const id = 'text-0'
  const two = await rawOf(key, [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: 'key sk-cur' },
    { type: 'text-delta', id, delta: 'sor-0123' },
    { type: 'raw', rawValue: { event: 'step_update', text: 'key sk-cursor-0123' } },
    { type: 'text-delta', id, delta: '456789abcdef!' },
    { type: 'raw', rawValue: { event: 'step_update', text: '456789abcdef!' } },
    { type: 'text-end', id },
  ])
  assertMasked(key, two.parts)
})

test("a key in deltas pi holds back past their native events is masked in those events' raw parts", async () => {
  const key = 'sk-pro-beZYXW-9f3k2Lq8mN4tRvA1x'
  const id = 'text-1'
  const deltas = ['key ', ...chunks(key, [2, 3, 1]), '!']
  const { parts } = await rawOf(key, [
    {
      type: 'raw',
      rawValue: { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end' } },
    },
    ...deltas.map((delta) => ({ type: 'raw', rawValue: piEvent('text_delta')(delta) })),
    { type: 'text-start', id },
    ...deltas.map((delta) => ({ type: 'text-delta', id, delta })),
    { type: 'text-end', id },
    {
      type: 'raw',
      rawValue: {
        type: 'message_end',
        message: { content: [{ type: 'text', text: deltas.join('') }] },
      },
    },
  ])
  assertMasked(key, parts)
})

test('a long turn of raw parts is held and masked in time linear in its parts', async () => {
  const key = 'sk-pro-beZYXW-9f3k2Lq8mN4tRvA1x'
  const words = Array.from({ length: 30_000 }, (_, i) => `w${i % 97} `)
  const started = performance.now()
  const { parts } = await rawOf(key, [
    ...streamed('text-0', 'text', [...words, ...chunks(key, [3])], piEvent('text_delta')),
  ])
  assert.ok(performance.now() - started < 10_000, 'holding and masking 60,000 parts took over 10s')
  assert.ok(parts.length > 60_000)
  assert.ok(!parts.some((p) => strings(p.rawValue).includes(key.slice(0, 6))))
})
