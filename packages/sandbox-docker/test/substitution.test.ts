// The substitution primitive the egress gateway brokers user secrets with, without the proxy.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import {
  ReplaceStream,
  type Substitution,
  scrubHeaders,
  substituteRequest,
  substitutes,
  unsubstituted,
} from '../src/egress/substitution.ts'
import { type DerivedTokens, tokeniseResponse, tokenPlaceholder } from '../src/egress/tokens.ts'

const SECRET = 'real-value-0123456789'
const HOLDER = `reeval_secret_${'Z'.repeat(32)}`
const sub = (over: Partial<Substitution> = {}): Substitution => ({
  name: 'KEY',
  placeholder: HOLDER,
  value: SECRET,
  hosts: ['api.example.com'],
  in: ['header'],
  ...over,
})

async function through(stream: ReplaceStream, chunks: string[]): Promise<string> {
  const out: Buffer[] = []
  for await (const c of Readable.from(chunks.map((c) => Buffer.from(c))).pipe(stream)) {
    out.push(c as Buffer)
  }
  return Buffer.concat(out).toString()
}

describe('ReplaceStream', () => {
  test('finds a match split across chunks at every offset', async () => {
    const text = `before ${HOLDER} middle ${HOLDER} after`
    for (let cut = 0; cut <= text.length; cut++) {
      for (const second of [cut, Math.min(text.length, cut + 7)]) {
        const chunks = [text.slice(0, cut), text.slice(cut, second), text.slice(second)]
        const stream = new ReplaceStream([[HOLDER, SECRET]])
        assert.equal(
          await through(stream, chunks),
          `before ${SECRET} middle ${SECRET} after`,
          `cut at ${cut}, ${second}`,
        )
        assert.equal(stream.count, 2)
      }
    }
  })

  test('byte by byte, with pairs of different lengths and a short one in the tail', async () => {
    const pairs: Array<[string, string]> = [
      ['long-pattern-abc', 'L'],
      ['xy', 'S'],
    ]
    const text = 'a long-pattern-abc b xy c long-pattern-ab xy'
    const stream = new ReplaceStream(pairs)
    assert.equal(await through(stream, [...text]), 'a L b S c long-pattern-ab S')
    assert.equal(stream.count, 3)
  })

  test("output isn't scanned again: a replacement containing the pattern stays as written", async () => {
    const stream = new ReplaceStream([['ab', 'xaby']])
    assert.equal(await through(stream, ['ab', 'ab']), 'xabyxaby')
  })

  test('no match passes bytes through unchanged, including binary', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13])
    const out: Buffer[] = []
    for await (const c of Readable.from([bytes]).pipe(new ReplaceStream([[HOLDER, SECRET]]))) {
      out.push(c as Buffer)
    }
    assert.deepEqual(Buffer.concat(out), bytes)
  })
})

describe('substituteRequest and scrubHeaders', () => {
  test('header substrings, multi-valued headers, and only the host the secret names', () => {
    const r = substituteRequest([sub()], {
      host: 'api.example.com',
      path: '/v1',
      headers: { authorization: `Bearer ${HOLDER}`, cookie: [`a=${HOLDER}`, 'b=1'] },
    })
    assert.deepEqual(r.headers, {
      authorization: `Bearer ${SECRET}`,
      cookie: [`a=${SECRET}`, 'b=1'],
    })
    assert.deepEqual(r.names, ['KEY'])
    const elsewhere = substituteRequest([sub()], {
      host: 'evil.example.com',
      path: '/',
      headers: { authorization: HOLDER },
    })
    assert.deepEqual([elsewhere.headers.authorization, elsewhere.names], [HOLDER, []])
  })

  test("wildcard hosts match subdomains only, as the allowlist's do", () => {
    const wild = [sub({ hosts: ['*.example.com'] })]
    assert.equal(substitutes(wild, 'api.example.com'), true)
    assert.equal(substitutes(wild, 'example.com'), false)
    assert.equal(substitutes(wild, 'evilexample.com'), false)
  })

  test('the query only with in: query, URL-encoded; never the path before it', () => {
    const request = { host: 'api.example.com', path: `/${HOLDER}?key=${HOLDER}`, headers: {} }
    assert.equal(substituteRequest([sub()], request).path, request.path)
    const q = substituteRequest([sub({ in: ['query'], value: 'a b&c' })], request)
    assert.equal(q.path, `/${HOLDER}?key=a%20b%26c`, 'encoded, so a value with & stays one param')
    assert.equal(encodeURIComponent(HOLDER), HOLDER, 'placeholders are URL-safe')
  })

  test('response headers get the placeholder back wherever the value appears', () => {
    assert.deepEqual(
      scrubHeaders([sub()], { 'x-echo': `key=${SECRET};`, 'set-cookie': [`s=${SECRET}`], n: '1' }),
      { 'x-echo': `key=${HOLDER};`, 'set-cookie': [`s=${HOLDER}`], n: '1' },
    )
  })
})

describe('unsubstituted', () => {
  const request = (path: string, headers: Record<string, string> = {}) => ({
    host: 'api.example.com',
    path,
    headers,
  })

  test('names a placeholder left in a place its secret does not substitute', () => {
    assert.deepEqual(unsubstituted([sub()], request(`/v1?key=${HOLDER}`)), [
      { name: 'KEY', where: 'query', in: ['header'] },
    ])
    assert.deepEqual(
      unsubstituted([sub({ in: ['query'] })], request('/v1', { authorization: HOLDER })),
      [{ name: 'KEY', where: 'header', in: ['query'] }],
    )
  })

  test('twin: nothing is named where the secret substitutes, or on another host', () => {
    assert.deepEqual(unsubstituted([sub()], request('/v1', { authorization: HOLDER })), [])
    assert.deepEqual(
      unsubstituted([sub({ in: ['header', 'query'] })], request(`/?k=${HOLDER}`)),
      [],
    )
    const elsewhere = { ...request(`/v1?key=${HOLDER}`), host: 'other.example.com' }
    assert.deepEqual(unsubstituted([sub()], elsewhere), [])
  })
})

describe('derived tokens', () => {
  const derived: DerivedTokens = {
    name: 'CURSOR_API_KEY',
    endpoint: { host: 'api2.cursor.sh', path: { exact: '/auth/exchange_user_api_key' } },
    fields: ['accessToken', 'refreshToken'],
    hosts: ['*.cursor.sh'],
  }

  test('a JWT keeps its header and claims; anything else gets a plain placeholder', () => {
    assert.match(
      tokenPlaceholder('aGVhZA.Y2xhaW1z.c2ln'),
      /^aGVhZA\.Y2xhaW1z\.reeval_secret_[0-9A-Za-z]{32}$/,
    )
    assert.match(tokenPlaceholder('opaque-token'), /^reeval_secret_[0-9A-Za-z]{32}$/)
    assert.notEqual(tokenPlaceholder('a.b.c'), tokenPlaceholder('a.b.c'), 'fresh each time')
  })

  test('each token field gets a header-only substitution on the token hosts, kept out of bodies', () => {
    const { body, added, fields } = tokeniseResponse(
      derived,
      JSON.stringify({ accessToken: 'a.b.c', refreshToken: 'opaque', n: 1 }),
      [],
    )
    assert.deepEqual(fields, ['accessToken', 'refreshToken'])
    assert.deepEqual(
      added.map((s) => [s.name, s.value, s.hosts, s.in, s.scrubBodies]),
      [
        ['CURSOR_API_KEY accessToken', 'a.b.c', ['*.cursor.sh'], ['header'], false],
        ['CURSOR_API_KEY refreshToken', 'opaque', ['*.cursor.sh'], ['header'], false],
      ],
    )
    assert.deepEqual(JSON.parse(body), {
      accessToken: added[0]?.placeholder,
      refreshToken: added[1]?.placeholder,
      n: 1,
    })
  })

  test('a token seen before keeps its placeholder; missing fields and non-objects', () => {
    const first = tokeniseResponse(derived, '{"accessToken":"a.b.c"}', [])
    const again = tokeniseResponse(derived, '{"accessToken":"a.b.c"}', first.added)
    assert.deepEqual(again.added, [])
    assert.equal(JSON.parse(again.body).accessToken, first.added[0]?.placeholder)
    assert.deepEqual(tokeniseResponse(derived, '{"other":1}', []).fields, [])
    assert.throws(() => tokeniseResponse(derived, '[1]', []), /not a JSON object/)
    assert.throws(() => tokeniseResponse(derived, 'oops', []), SyntaxError)
  })
})
