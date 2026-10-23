import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { costLine, formatUsdRange, type PlanCost, planCost, priceOf } from '../src/cost.ts'
import { PRICES } from '../src/prices.ts'
import type { Cell } from '../src/types.ts'

const cell = (harness: string): Cell => ({
  key: `${harness}/-/docker`,
  harness,
  environment: '-',
  sandbox: 'docker',
  role: 'control',
})

describe('priceOf', () => {
  test('matches the id without a provider prefix, param labels or a trailing effort', () => {
    const flash = PRICES['gemini-3.8-flash']
    assert.ok(flash)
    assert.deepEqual(priceOf('gemini-3.8-flash'), flash)
    assert.deepEqual(priceOf('google/gemini-3.8-flash'), flash)
    assert.deepEqual(priceOf('gemini-3.8-flash-medium'), flash)
    assert.deepEqual(priceOf('gemini-3.8-flash[effort=high]'), flash)
  })

  test('is null for a model without an exact price, rather than a near one', () => {
    assert.equal(priceOf('my-model'), null)
    assert.equal(priceOf('gemini-3.8-flash-lite-preview-99'), null)
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
    )
    assert.equal(cost.cells[0]?.model, 'composer-2.5-fast')
  })
})

describe('formatUsdRange', () => {
  test('cents under $10, whole dollars above, the low end down and the high end up', () => {
    assert.equal(formatUsdRange({ low: 0.0712, high: 0.4801 }), '$0.07–0.49')
    assert.equal(formatUsdRange({ low: 3.67, high: 27.26 }), '$3–28')
    assert.equal(formatUsdRange({ low: 1200.4, high: 3400.2 }), '$1,200–3,401')
    assert.equal(formatUsdRange({ low: 0, high: 0.004 }), 'under $0.01')
    assert.equal(formatUsdRange({ low: 0.003, high: 0.018 }), 'up to $0.02')
    assert.equal(formatUsdRange({ low: 0.5, high: 0.5 }), 'about $0.50')
  })
})

describe('costLine', () => {
  const base: PlanCost = {
    usd: { low: 1, high: 4 },
    agent: { low: 1, high: 3.8 },
    judge: { low: 0, high: 0.2 },
    attempts: { history: 0, typical: 6, unpriced: 0, free: 0 },
    pastRuns: 0,
    pastAttempts: 0,
    unpriced: { agent: [], judge: [] },
    prices: { date: '2026-10-23', source: 'models.dev' },
    cells: [],
  }

  test('says what the range is based on', () => {
    assert.equal(
      costLine(base),
      'cost  estimated $1.00–4.00 at list prices, judge included · no history, rough',
    )
    assert.equal(
      costLine({ ...base, attempts: { ...base.attempts, history: 6, typical: 0 }, pastRuns: 12 }),
      'cost  estimated $1.00–4.00 at list prices, judge included · from 12 past runs',
    )
    assert.equal(
      costLine({ ...base, attempts: { ...base.attempts, history: 2, typical: 4 }, pastRuns: 1 }),
      'cost  estimated $1.00–4.00 at list prices, judge included · 2 of 6 attempts from 1 past run, the rest rough',
    )
  })

  test('names what it left out, and prints nothing for the fake agent alone', () => {
    assert.equal(
      costLine({
        ...base,
        usd: null,
        agent: null,
        judge: null,
        attempts: { history: 0, typical: 0, unpriced: 3, free: 0 },
        unpriced: { agent: ['my-model'], judge: [] },
      }),
      'cost  3 attempts left out: no list price for my-model',
    )
    assert.equal(
      costLine({
        ...base,
        usd: null,
        agent: null,
        judge: null,
        attempts: { history: 0, typical: 0, unpriced: 0, free: 4 },
      }),
      null,
    )
  })
})
