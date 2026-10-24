import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  costLine,
  formatTokenRange,
  formatUsdRange,
  type PlanCost,
  planCost,
  priceFor,
  usdOf,
} from '../src/cost.ts'
import { UsageError } from '../src/errors.ts'
import { loadPrices, type Price, type Prices } from '../src/prices.ts'
import type { Cell } from '../src/types.ts'

const FLASH: Price = [0.75, 0.075, 0.75, 3.75]
const TABLE: Record<string, Price> = {
  'gemini-3.8-flash': FLASH,
  'composer-2.5-fast': [3, 0.5, 3, 15],
}
const PRICES = {
  table: TABLE,
  overlay: null,
  file: null,
  modelsDev: { fetchedAt: '2026-10-23T00:00:00Z', stale: false as const },
}

const cell = (harness: string): Cell => ({
  key: `${harness}/-/docker`,
  harness,
  environment: '-',
  sandbox: 'docker',
  role: 'control',
})

describe('priceFor', () => {
  test('matches the id without a provider prefix, param labels or a trailing effort', () => {
    assert.deepEqual(priceFor('gemini-3.8-flash', TABLE), FLASH)
    assert.deepEqual(priceFor('google/gemini-3.8-flash', TABLE), FLASH)
    assert.deepEqual(priceFor('gemini-3.8-flash-medium', TABLE), FLASH)
    assert.deepEqual(priceFor('gemini-3.8-flash[effort=high]', TABLE), FLASH)
  })

  test("matches a gateway's `provider/model` id as written before the bare id", () => {
    const sonnet: Price = [3, 0.3, 3.75, 15]
    const table = { ...TABLE, 'anthropic/claude-sonnet-4.5': sonnet }
    assert.deepEqual(priceFor('anthropic/claude-sonnet-4.5', table), sonnet)
    assert.deepEqual(priceFor('anthropic/claude-sonnet-4.5-high', table), sonnet)
    assert.equal(priceFor('claude-sonnet-4.5', table), null)
  })

  test('prices reasoning as part of output, never on top of it', () => {
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }
    assert.equal(usdOf({ ...tokens, reasoning: 800_000 }, FLASH), usdOf(tokens, FLASH))
  })

  test('is null for a model without an exact price, rather than a near one', () => {
    assert.equal(priceFor('my-model', TABLE), null)
    assert.equal(priceFor('gemini-3.8-flash-lite', TABLE), null)
  })

  test("reads the table's own entries only, so an id like `constructor` is just unpriced", () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(priceFor(id, TABLE), null)
      assert.equal(priceFor(`openai/${id}`, TABLE), null)
    }
  })

  test("Cursor's Fast is priced as its own model", () => {
    const cost = planCost(
      [
        {
          id: 'e',
          cell: cell('cursor:composer-2.5'),
          harness: { kind: 'cursor', model: 'composer-2.5', params: { fast: 'true' } },
        },
      ],
      [],
      null,
      PRICES,
    )
    assert.equal(cost.cells[0]?.model, 'composer-2.5-fast')
    assert.ok(cost.usd)
  })

  test('a REEVAL_PRICES entry wins over every models.dev id it matches', () => {
    const cost = planCost(
      [
        {
          id: 'e',
          cell: cell('fx:anthropic/claude-sonnet-4.5'),
          harness: { kind: 'fx', model: 'anthropic/claude-sonnet-4.5' },
        },
      ],
      [],
      null,
      {
        ...PRICES,
        table: { ...TABLE, 'anthropic/claude-sonnet-4.5': [3, 0.3, 3.75, 15] },
        overlay: { 'claude-sonnet-4.5': [1, 1, 1, 1] },
        file: 'prices.json',
      },
    )
    assert.deepEqual(cost.usd, { low: 0.303, high: 2.02 })
  })

  test('without prices, the estimate is tokens alone and says why', () => {
    const cost = planCost(
      [
        {
          id: 'e',
          cell: cell('pi:gemini-3.8-flash'),
          harness: { kind: 'pi', model: 'gemini-3.8-flash' },
        },
      ],
      [],
      null,
      { table: null, why: 'models.dev unreachable' },
    )
    assert.equal(cost.usd, null)
    assert.deepEqual(cost.tokens, { low: 303_000, high: 2_020_000 })
    assert.equal(
      costLine(cost),
      'cost  estimated 0.3–2.1M tokens · no prices: models.dev unreachable · no history, rough',
    )
  })
})

describe('formatting', () => {
  test('dollars: cents under $10, whole dollars above, the low end down and the high end up', () => {
    assert.equal(formatUsdRange({ low: 0.0712, high: 0.4801 }), '$0.07–0.49')
    assert.equal(formatUsdRange({ low: 3.67, high: 27.26 }), '$3–28')
    assert.equal(formatUsdRange({ low: 1200.4, high: 3400.2 }), '$1,200–3,401')
    assert.equal(formatUsdRange({ low: 0, high: 0.004 }), 'under $0.01')
    assert.equal(formatUsdRange({ low: 0.003, high: 0.018 }), 'up to $0.02')
    assert.equal(formatUsdRange({ low: 0.5, high: 0.5 }), 'about $0.50')
  })

  test('tokens: k under a million, M above', () => {
    assert.equal(formatTokenRange({ low: 120_400, high: 899_100 }), '120–900k tokens')
    assert.equal(formatTokenRange({ low: 606_000, high: 4_040_000 }), '0.6–4.1M tokens')
    assert.equal(formatTokenRange({ low: 0, high: 62_000 }), 'up to 62k tokens')
  })
})

describe('costLine', () => {
  const base: PlanCost = {
    tokens: { low: 1_000_000, high: 9_000_000 },
    usd: { low: 1, high: 4 },
    agent: { tokens: { low: 1_000_000, high: 8_000_000 }, usd: { low: 1, high: 3.8 } },
    judge: { tokens: { low: 0, high: 1_000_000 }, usd: { low: 0, high: 0.2 } },
    unpricedTokens: { low: 0, high: 0 },
    attempts: { history: 0, typical: 6, free: 0 },
    pastRuns: 0,
    pastAttempts: 0,
    unpriced: [],
    prices: { modelsDev: { fetchedAt: '2026-10-23T00:00:00Z', stale: false }, file: null },
    cells: [],
  }

  test('says what the range is based on, and where the prices came from', () => {
    assert.equal(
      costLine(base),
      'cost  estimated $1.00–4.00 at models.dev list prices, judge included · no history, rough',
    )
    assert.equal(
      costLine({ ...base, attempts: { ...base.attempts, history: 6, typical: 0 }, pastRuns: 12 }),
      'cost  estimated $1.00–4.00 at models.dev list prices, judge included · from 12 past runs',
    )
    assert.equal(
      costLine({
        ...base,
        attempts: { ...base.attempts, history: 2, typical: 4 },
        pastRuns: 1,
        prices: {
          modelsDev: { stale: true, fetchedAt: '2026-10-20T08:00:00Z', why: 'unreachable' },
          file: null,
        },
      }),
      'cost  estimated $1.00–4.00 at models.dev list prices of 2026-10-20 (offline), judge included · 2 of 6 attempts from 1 past run, the rest rough',
    )
    assert.equal(
      costLine({
        ...base,
        prices: {
          modelsDev: { stale: true, fetchedAt: '2026-10-20T08:00:00Z', why: 'answered HTTP 500' },
          file: null,
        },
      }),
      'cost  estimated $1.00–4.00 at models.dev list prices of 2026-10-20 (models.dev answered HTTP 500), judge included · no history, rough',
    )
  })

  test('with models it has no price for, says what the dollars cover and what they leave out', () => {
    const judgeOnly = {
      ...base,
      usd: { low: 0, high: 0.06 },
      unpricedTokens: { low: 300_000, high: 2_100_000 },
      unpriced: [{ model: 'composer-2.5', tokens: { low: 300_000, high: 2_100_000 } }],
      cells: [
        {
          eval: 'e',
          cell: 'cursor:composer-2.5/-/docker',
          model: 'composer-2.5',
          judgeModel: 'google/gemini-3.8-flash',
          attempts: 1,
          basis: 'typical' as const,
          samples: 0,
          agent: { tokens: { low: 300_000, high: 2_100_000 }, usd: null },
          judge: { tokens: { low: 0, high: 62_000 }, usd: { low: 0, high: 0.06 } },
        },
      ],
    }
    assert.equal(
      costLine(judgeOnly),
      'cost  up to $0.06 priced (judge only) at models.dev list prices; composer-2.5: 0.3–2.1M tokens, no list price · no history, rough',
    )
    const sonnet = {
      ...judgeOnly.cells[0],
      cell: 'claude-code:claude-sonnet-5/-/docker',
      model: 'claude-sonnet-5',
      agent: { tokens: { low: 300_000, high: 2_100_000 }, usd: { low: 0.2, high: 1.2 } },
      judge: { tokens: { low: 0, high: 62_000 }, usd: null },
    }
    assert.equal(
      costLine({
        ...judgeOnly,
        usd: { low: 0.2, high: 1.2 },
        unpriced: [{ model: 'my-judge', tokens: { low: 0, high: 62_000 } }, ...judgeOnly.unpriced],
        cells: [{ ...judgeOnly.cells[0], judge: sonnet.judge }, sonnet],
        prices: {
          modelsDev: { why: 'models.dev unreachable, next try in 60m' },
          file: 'prices.json',
        },
      }),
      'cost  $0.20–1.20 priced (claude-sonnet-5 only) at prices.json (models.dev unreachable, next try in 60m); my-judge: up to 62k tokens, composer-2.5: 0.3–2.1M tokens, no list price · no history, rough',
    )
  })

  test('names a REEVAL_PRICES file over models.dev', () => {
    assert.equal(
      costLine({ ...base, prices: { ...base.prices, file: 'prices.json' } }),
      'cost  estimated $1.00–4.00 at prices.json over models.dev list prices, judge included · no history, rough',
    )
  })

  test('prints nothing for the fake agent and judge alone', () => {
    assert.equal(
      costLine({
        ...base,
        tokens: { low: 0, high: 0 },
        usd: null,
        attempts: { history: 0, typical: 0, free: 4 },
      }),
      null,
    )
  })
})

describe('loadPrices', () => {
  const cache = () => {
    const dir = mkdtempSync(join(tmpdir(), 'reeval-prices-'))
    process.env.XDG_CACHE_HOME = dir
    return { dir, env: {} }
  }
  const before = process.env.XDG_CACHE_HOME
  after(() => {
    if (before === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = before
  })
  const now = Date.parse('2026-10-23T12:00:00Z')
  const CATALOG = {
    google: {
      models: {
        'gemini-3.8-flash': { cost: { input: 0.75, output: 3.75, cache_read: 0.075 } },
      },
    },
    vercel: {
      models: { 'anthropic/claude-sonnet-4.5': { cost: { input: 3, output: 15 } } },
    },
    openrouter: { models: { other: { cost: { input: 1, output: 1 } } } },
    openai: { models: { 'no-cost': {}, 'bad-cost': { cost: { input: '1', output: 2 } } } },
  }

  /**
   * A local models.dev: `answer` serves the catalog gzipped (or `body` instead), `hang` accepts
   * and never answers.
   */
  async function server(mode: 'answer' | 'hang', body: Buffer = gzipSync(JSON.stringify(CATALOG))) {
    const hits: number[] = []
    const closed: Promise<void>[] = []
    const srv = createServer((_req, res) => {
      hits.push(Date.now())
      if (mode === 'hang') return
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(body)
    })
    srv.on('connection', (socket) => {
      closed.push(new Promise((done) => socket.on('close', () => done())))
    })
    await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done))
    const { port } = srv.address() as AddressInfo
    const source = { url: `http://127.0.0.1:${port}/api.json`, timeoutMs: 300 }
    const stop = () => new Promise<void>((done) => srv.close(() => done()))
    return { source, hits, closed, stop }
  }
  /** Nothing listens on a port that was just closed. */
  async function refused() {
    const s = await server('answer')
    await s.stop()
    return s.source
  }

  const fetchedAt = (p: Prices) =>
    p.table && 'fetchedAt' in p.modelsDev ? p.modelsDev.fetchedAt : null
  const UNREACHABLE = 'models.dev unreachable, next try in 60m'

  test('REEVAL_PRICES=none is tokens only, and a bad file is a usage error naming what is wrong', async () => {
    assert.deepEqual(await loadPrices({ REEVAL_PRICES: 'none' }), {
      table: null,
      why: 'REEVAL_PRICES=none',
    })
    const { dir } = cache()
    const file = join(dir, 'prices.json')
    const refused = async (contents: string, message: RegExp) => {
      writeFileSync(file, contents)
      await assert.rejects(loadPrices({ REEVAL_PRICES: file }), (error: Error) => {
        assert.ok(error instanceof UsageError, error.message)
        assert.match(error.message, /^REEVAL_PRICES .*prices\.json: /)
        assert.match(error.message, message)
        return true
      })
    }
    for (const cost of [{ input: 0.5 }, { input: '0.5', output: 2 }, { input: -1, output: 2 }, 3]) {
      await refused(
        JSON.stringify({ 'composer-2.5': cost }),
        /composer-2\.5 needs input and output/,
      )
    }
    await refused(
      JSON.stringify({ 'composer-2.5': { input: 0.5, cacheRead: 0.05, output: 2.5 } }),
      /composer-2\.5 has cacheRead, which isn't one of input, output, cache_read, cache_write$/,
    )
    for (const top of ['[{"input":1,"output":1}]', 'null', '3', '"composer-2.5"']) {
      await refused(top, /must be a JSON object of prices by model id/)
    }
    await refused(
      JSON.stringify({
        'Composer-2.5': { input: 1, output: 1 },
        'composer-2.5': { input: 2, output: 2 },
      }),
      /Composer-2\.5 and composer-2\.5 are one model; keep one$/,
    )
    await refused('{ "composer-2.5": ', /isn't JSON: /)
    await assert.rejects(
      loadPrices({ REEVAL_PRICES: join(dir, 'missing.json') }),
      /^UsageError: REEVAL_PRICES .*missing\.json: can't be read \(ENOENT\)$/,
    )
  })

  test('a REEVAL_PRICES id like `__proto__` is an ordinary model', async (t) => {
    const s = await server('answer')
    t.after(s.stop)
    const { dir } = cache()
    const file = join(dir, 'prices.json')
    writeFileSync(file, '{"__proto__":{"input":1,"output":2},"constructor":{"input":3,"output":4}}')
    const prices = await loadPrices({ REEVAL_PRICES: file }, now, s.source)
    const overlay = prices.table ? prices.overlay : null
    assert.ok(overlay)
    assert.deepEqual(Object.keys(overlay), ['__proto__', 'constructor'])
    assert.deepEqual(priceFor('__proto__', overlay), [1, 1, 1, 2])
    assert.deepEqual(priceFor('constructor', overlay), [3, 3, 3, 4])
  })

  test('a REEVAL_PRICES file lies over models.dev, and stands alone when it is unreachable', async (t) => {
    const s = await server('answer')
    t.after(s.stop)
    const { dir } = cache()
    const file = join(dir, 'prices.json')
    writeFileSync(
      file,
      JSON.stringify({ 'Composer-2.5': { input: 0.5, cache_read: 0.2, output: 2.5 } }),
    )
    const overlay = { 'composer-2.5': [0.5, 0.2, 0.5, 2.5] }
    const both = await loadPrices({ REEVAL_PRICES: file }, now, s.source)
    assert.deepEqual(both.table?.['gemini-3.8-flash'], FLASH)
    assert.deepEqual(both.table && both.overlay, overlay)
    assert.equal(fetchedAt(both), new Date(now).toISOString())
    cache()
    assert.deepEqual(await loadPrices({ REEVAL_PRICES: file }, now, await refused()), {
      table: {},
      overlay,
      file: both.table && both.file,
      modelsDev: { why: UNREACHABLE },
    })
  })

  const seed = (dir: string, fetchedAt: string, table: unknown = TABLE) => {
    mkdirSync(join(dir, 'reeval'), { recursive: true })
    writeFileSync(
      join(dir, 'reeval', 'models-dev-prices.json'),
      JSON.stringify({ fetchedAt, table }),
    )
  }

  test('a cache under a day old is used without fetching', async (t) => {
    const s = await server('answer')
    t.after(s.stop)
    const { dir, env } = cache()
    seed(dir, '2026-10-23T06:00:00Z')
    const prices = await loadPrices(env, now, s.source)
    assert.equal(s.hits.length, 0)
    assert.deepEqual(prices, {
      table: TABLE,
      overlay: null,
      file: null,
      modelsDev: { fetchedAt: '2026-10-23T06:00:00Z', stale: false },
    })
  })

  test('a corrupt cache, or one dated in the future, is fetched again', async (t) => {
    const s = await server('answer')
    t.after(s.stop)
    const { dir, env } = cache()
    for (const [at, table] of [
      ['2026-10-23T06:00:00Z', { 'gemini-3.8-flash': 'oops' }],
      ['2026-10-23T06:00:00Z', { 'gemini-3.8-flash': [1, 2] }],
      ['not a date', TABLE],
      ['2099-01-01T00:00:00Z', TABLE],
    ] as const) {
      seed(dir, at, table)
      assert.equal(fetchedAt(await loadPrices(env, now, s.source)), new Date(now).toISOString())
    }
    assert.equal(s.hits.length, 4)
  })

  test('offline, an older cache is used and marked stale; with none, there are no prices', async () => {
    const source = await refused()
    const { dir, env } = cache()
    seed(dir, '2026-10-01T00:00:00Z')
    const stale = await loadPrices(env, now, source)
    assert.deepEqual(stale.table && stale.modelsDev, {
      fetchedAt: '2026-10-01T00:00:00Z',
      stale: true,
      why: 'unreachable',
    })
    cache()
    assert.deepEqual(await loadPrices({}, now, source), { table: null, why: UNREACHABLE })
  })

  test('a failed fetch is not tried again for an hour', async (t) => {
    cache()
    assert.deepEqual(await loadPrices({}, now, await refused()), { table: null, why: UNREACHABLE })
    const s = await server('answer')
    t.after(s.stop)
    assert.deepEqual(await loadPrices({}, now + 15 * 60_000, s.source), {
      table: null,
      why: 'models.dev unreachable, next try in 45m',
    })
    assert.equal(s.hits.length, 0)
    const later = now + 61 * 60_000
    assert.equal(fetchedAt(await loadPrices({}, later, s.source)), new Date(later).toISOString())
    assert.equal(s.hits.length, 1)
  })

  test('a host that never answers gives up at the deadline and closes the socket', async (t) => {
    const s = await server('hang')
    t.after(s.stop)
    const { env } = cache()
    const start = Date.now()
    assert.deepEqual(await loadPrices(env, now, s.source), { table: null, why: UNREACHABLE })
    assert.ok(Date.now() - start < 2000, 'waited past the deadline')
    assert.equal(s.hits.length, 1)
    await Promise.all(s.closed)
  })

  test("a fetch keeps the direct providers' and the gateway's priced models and caches them", async (t) => {
    const s = await server('answer')
    t.after(s.stop)
    const { env } = cache()
    const expected = {
      'gemini-3.8-flash': FLASH,
      'anthropic/claude-sonnet-4.5': [3, 3, 3, 15],
    }
    assert.deepEqual((await loadPrices(env, now, s.source)).table, expected)
    await s.stop()
    assert.deepEqual((await loadPrices(env, now, await refused())).table, expected)
    assert.equal(s.hits.length, 1)
  })

  test('an answer without prices is neither cached nor laid over the good copy, and says so', async (t) => {
    const { dir, env } = cache()
    seed(dir, '2026-10-01T00:00:00Z')
    for (const [body, why] of [
      ['[1,2]', 'answered without prices'],
      [
        '{"openrouter":{"models":{"a":{"cost":{"input":1,"output":1}}}}}',
        'answered without prices',
      ],
      ['{"openai":', 'answered with invalid JSON'],
    ]) {
      const s = await server('answer', gzipSync(body))
      t.after(s.stop)
      rmSync(join(dir, 'reeval', 'models-dev-failed.json'), { force: true })
      const prices = await loadPrices(env, now, s.source)
      assert.deepEqual(prices.table, TABLE)
      assert.deepEqual(prices.table && prices.modelsDev, {
        fetchedAt: '2026-10-01T00:00:00Z',
        stale: true,
        why,
      })
      assert.equal(s.hits.length, 1)
    }
    cache()
    const s = await server('answer', gzipSync('[]'))
    t.after(s.stop)
    const why = 'models.dev answered without prices, next try in 60m'
    assert.deepEqual(await loadPrices({}, now, s.source), { table: null, why })
    assert.deepEqual(await loadPrices({}, now, s.source), { table: null, why })
    assert.equal(s.hits.length, 1)
  })

  test('a malformed model entry is skipped, not the whole catalog', async (t) => {
    const catalog = {
      ...CATALOG,
      xai: { models: { a: null, b: 3, c: { cost: null } } },
      anthropic: null,
    }
    const s = await server('answer', gzipSync(JSON.stringify(catalog)))
    t.after(s.stop)
    const { env } = cache()
    assert.deepEqual((await loadPrices(env, now, s.source)).table, {
      'gemini-3.8-flash': FLASH,
      'anthropic/claude-sonnet-4.5': [3, 3, 3, 15],
    })
  })

  test('an answer that decompresses past 32 MB is a failed fetch', async (t) => {
    const s = await server('answer', gzipSync(Buffer.alloc(33 * 1024 * 1024, ' ')))
    t.after(s.stop)
    cache()
    assert.deepEqual(await loadPrices({}, now, { ...s.source, timeoutMs: 5000 }), {
      table: null,
      why: 'models.dev answered over 32 MB, next try in 60m',
    })
  })

  test('the fetch goes through the environment proxy under NODE_USE_ENV_PROXY=1', async (t) => {
    const seen: string[] = []
    const proxy = createServer((req, res) => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.end(gzipSync(JSON.stringify(CATALOG)))
    })
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done))
    t.after(() => new Promise<void>((done) => proxy.close(() => done())))
    const { dir } = cache()
    const prices = new URL('../src/prices.ts', import.meta.url).href
    const script = `const { loadPrices } = await import(${JSON.stringify(prices)})
const p = await loadPrices({}, Date.now(), { url: 'http://models.reeval.test/api.json', timeoutMs: 3000 })
console.log(JSON.stringify(p.table))`
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      {
        env: {
          ...process.env,
          XDG_CACHE_HOME: dir,
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
          NO_PROXY: '',
        },
      },
    )
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    await new Promise((done) => child.on('close', done))
    assert.deepEqual(seen, ['http://models.reeval.test/api.json'])
    assert.deepEqual(JSON.parse(out), {
      'gemini-3.8-flash': FLASH,
      'anthropic/claude-sonnet-4.5': [3, 3, 3, 15],
    })
  })
})
