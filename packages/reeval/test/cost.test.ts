import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import { loadPrices, type Price } from '../src/prices.ts'
import type { Cell } from '../src/types.ts'

const FLASH: Price = [0.75, 0.075, 0.75, 3.75]
const TABLE: Record<string, Price> = {
  'gemini-3.8-flash': FLASH,
  'composer-2.5-fast': [3, 0.5, 3, 15],
}
const PRICES = {
  table: TABLE,
  source: 'models.dev',
  fetchedAt: '2026-10-23T00:00:00Z',
  stale: false,
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
    prices: { source: 'models.dev', fetchedAt: '2026-10-23T00:00:00Z', stale: false },
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
        prices: { ...base.prices, stale: true, fetchedAt: '2026-10-20T08:00:00Z' },
      }),
      'cost  estimated $1.00–4.00 at models.dev list prices of 2026-10-20 (offline), judge included · 2 of 6 attempts from 1 past run, the rest rough',
    )
  })

  test('adds the tokens it could not price, naming the models', () => {
    assert.equal(
      costLine({
        ...base,
        unpricedTokens: { low: 600_000, high: 4_000_000 },
        unpriced: ['my-model'],
      }),
      'cost  estimated $1.00–4.00 at models.dev list prices, judge included · plus 0.6–4.0M tokens with no list price (my-model) · no history, rough',
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

  /** A local models.dev: `answer` serves the catalog gzipped, `hang` accepts and never answers. */
  async function server(mode: 'answer' | 'hang') {
    const hits: number[] = []
    const closed: Promise<void>[] = []
    const srv = createServer((_req, res) => {
      hits.push(Date.now())
      if (mode === 'hang') return
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(gzipSync(JSON.stringify(CATALOG)))
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

  test('REEVAL_PRICES=none is tokens only, and a file is used instead of models.dev', async () => {
    assert.deepEqual(await loadPrices({ REEVAL_PRICES: 'none' }), {
      table: null,
      why: 'REEVAL_PRICES=none',
    })
    const { dir } = cache()
    const file = join(dir, 'prices.json')
    writeFileSync(
      file,
      JSON.stringify({ 'Composer-2.5': { input: 0.5, cache_read: 0.2, output: 2.5 } }),
    )
    const prices = await loadPrices({ REEVAL_PRICES: file })
    assert.deepEqual(prices.table, { 'composer-2.5': [0.5, 0.2, 0.5, 2.5] })
    for (const cost of [{ input: 0.5 }, { input: '0.5', output: 2 }, { input: -1, output: 2 }]) {
      writeFileSync(file, JSON.stringify({ 'composer-2.5': cost }))
      const bad = await loadPrices({ REEVAL_PRICES: file })
      assert.equal(bad.table, null)
      assert.match('why' in bad ? bad.why : '', /composer-2\.5 needs input and output/)
    }
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
      source: 'models.dev',
      fetchedAt: '2026-10-23T06:00:00Z',
      stale: false,
    })
  })

  test('a corrupt cache, or one dated in the future, is fetched again', async (t) => {
    const s = await server('answer')
    t.after(s.stop)
    const { dir, env } = cache()
    for (const [fetchedAt, table] of [
      ['2026-10-23T06:00:00Z', { 'gemini-3.8-flash': 'oops' }],
      ['2026-10-23T06:00:00Z', { 'gemini-3.8-flash': [1, 2] }],
      ['not a date', TABLE],
      ['2099-01-01T00:00:00Z', TABLE],
    ] as const) {
      seed(dir, fetchedAt, table)
      const prices = await loadPrices(env, now, s.source)
      assert.equal('stale' in prices && prices.fetchedAt, new Date(now).toISOString())
    }
    assert.equal(s.hits.length, 4)
  })

  test('offline, an older cache is used and marked stale; with none, there are no prices', async () => {
    const source = await refused()
    const { dir, env } = cache()
    seed(dir, '2026-10-01T00:00:00Z')
    const stale = await loadPrices(env, now, source)
    assert.equal('stale' in stale && stale.stale, true)
    cache()
    assert.deepEqual(await loadPrices({}, now, source), {
      table: null,
      why: 'models.dev unreachable',
    })
  })

  test('a host that never answers gives up at the deadline and closes the socket', async (t) => {
    const s = await server('hang')
    t.after(s.stop)
    const { env } = cache()
    const start = Date.now()
    assert.deepEqual(await loadPrices(env, now, s.source), {
      table: null,
      why: 'models.dev unreachable',
    })
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
})
