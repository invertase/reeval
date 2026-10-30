import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cursorEffortParam } from '@reeval/harness-cursor-sdk'
import { UsageError } from '../src/errors.ts'
import {
  checkCursorCatalog,
  checkCursorPlan,
  cursorCatalogProblem,
} from '../src/harness/cursor-catalog.ts'
import {
  DEFAULT_EFFORT,
  effortNotes,
  noDefaultEffort,
  withDefaultEffort,
} from '../src/harness/default-effort.ts'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fx,
  grokBuild,
  opencode,
  pi,
} from '../src/harness.ts'
import { harnessId } from '../src/options.ts'
import { effortSummary } from '../src/plan.ts'
import type { CursorEfforts } from '../src/types.ts'
import { colors } from '../src/ui/colors.ts'
import type { RunHeader } from '../src/ui/events.ts'
import { headerLines } from '../src/ui/header.ts'

const values = (...vs: string[]) => vs.map((value) => ({ value }))
const CATALOG = [
  { id: 'composer-2.5', parameters: [{ id: 'fast', values: values('false', 'true') }] },
  {
    id: 'gpt-5.6-luna',
    parameters: [
      { id: 'reasoning', values: values('low', 'medium', 'high') },
      { id: 'fast', values: values('false', 'true') },
    ],
  },
  {
    id: 'claude-opus-5',
    parameters: [
      { id: 'thinking', values: values('false', 'true') },
      { id: 'effort', values: values('low', 'medium', 'high') },
    ],
  },
  { id: 'kimi-k3', parameters: [{ id: 'effort', values: values('low', 'high', 'max') }] },
]
const EFFORTS: CursorEfforts = {
  'composer-2.5': null,
  'gpt-5.6-luna': { param: 'reasoning', levels: ['low', 'medium', 'high'] },
  'claude-opus-5': { param: 'effort', levels: ['low', 'medium', 'high'] },
  'kimi-k3': { param: 'effort', levels: ['low', 'high', 'max'] },
}

describe('the shared default effort', () => {
  test('is medium, set where the harness and model take one, keeping the cell id', () => {
    const h = withDefaultEffort(codex({ model: 'gpt-5.6-sol' }))
    assert.equal(DEFAULT_EFFORT, 'medium')
    assert.deepEqual(h, {
      kind: 'codex',
      model: 'gpt-5.6-sol',
      id: 'codex:gpt-5.6-sol',
      effort: 'medium',
    })
    assert.equal(harnessId(h), 'codex:gpt-5.6-sol')
    assert.equal(withDefaultEffort(pi({ model: 'gemini-3.8-flash' })).effort, 'medium')
    assert.equal(withDefaultEffort(grokBuild({ model: 'grok-4.6' })).effort, 'medium')
    assert.equal(withDefaultEffort(claudeCode({ model: 'claude-sonnet-5-5' })).effort, 'medium')
    assert.equal(withDefaultEffort(antigravity({ model: 'gemini-3.8-flash' })).effort, 'medium')
  })

  test("leaves a factory's own effort alone", () => {
    const h = codex({ model: 'gpt-5.6-sol', effort: 'high' })
    assert.equal(withDefaultEffort(h), h)
  })

  test('is left off, with the reason, where no effort can be sent', () => {
    assert.equal(
      noDefaultEffort(claudeCode({ model: 'claude-haiku-4-5' })),
      'Claude Code sends no effort to claude-haiku-4-5',
    )
    assert.equal(
      noDefaultEffort(antigravity({ model: 'gemini-3.8-flash-low' })),
      'the model id names its effort, low',
    )
    assert.match(noDefaultEffort(fx({ model: 'gpt-5.4-mini' })) ?? '', /fx sends no effort/)
    const haiku = claudeCode({ model: 'claude-haiku-4-5' })
    assert.equal(withDefaultEffort(haiku), haiku)
  })

  test("is left off where OpenCode's model answers an effort with a 400", () => {
    const haiku = opencode({ model: 'anthropic/claude-haiku-4-5' })
    assert.equal(noDefaultEffort(haiku), "Anthropic's API takes no effort on claude-haiku-4-5")
    assert.equal(withDefaultEffort(haiku), haiku)
    assert.match(
      noDefaultEffort(opencode({ model: 'openai/gpt-4.1' })) ?? '',
      /OpenAI's API takes no reasoning effort on gpt-4\.1/,
    )
    assert.match(
      noDefaultEffort(opencode({ model: 'google/gemini-2.5-flash' })) ?? '',
      /Gemini's API takes no thinking level on gemini-2\.5-flash/,
    )
    assert.match(
      noDefaultEffort(opencode({ model: 'openai/gpt-5-pro' })) ?? '',
      /takes only effort high on gpt-5-pro, not medium/,
    )
    assert.equal(
      withDefaultEffort(opencode({ model: 'anthropic/claude-sonnet-5-5' })).effort,
      'medium',
    )
  })

  test("follows the API OpenCode's gateway calls: OpenRouter maps an effort onto Gemini 2.5", () => {
    const flash = opencode({ model: 'google/gemini-2.5-flash' })
    assert.equal(withDefaultEffort({ ...flash, gateway: 'openrouter' }).effort, 'medium')
    assert.match(
      noDefaultEffort({ ...flash, gateway: 'vercel' }) ?? '',
      /Gemini's API takes no thinking level on gemini-2\.5-flash/,
    )
    assert.match(
      noDefaultEffort({ ...flash, gateway: 'vertex' }) ?? '',
      /Gemini's API takes no thinking level on gemini-2\.5-flash/,
    )
  })

  test("follows Cursor's catalog for each model", () => {
    const composer = cursor({ model: 'composer-2.5', params: { fast: 'false' } })
    assert.equal(noDefaultEffort(composer), 'unchecked')
    assert.equal(
      noDefaultEffort(composer, EFFORTS),
      "Cursor's model catalog lists no effort for composer-2.5",
    )
    assert.equal(withDefaultEffort(composer, EFFORTS), composer)
    assert.equal(withDefaultEffort(cursor({ model: 'gpt-5.6-luna' }), EFFORTS).effort, 'medium')
    assert.equal(
      noDefaultEffort(cursor({ model: 'kimi-k3' }), EFFORTS),
      'kimi-k3 takes effort low, high, max, not medium',
    )
    const viaParams = withDefaultEffort(
      cursor({ model: 'gpt-5.6-luna', params: { reasoning: 'high' } }),
      EFFORTS,
    )
    assert.equal(viaParams.effort, 'high')
    assert.equal(harnessId(viaParams), 'cursor:gpt-5.6-luna')
  })

  test('notes the cells with none, and efforts that differ under the same ids', () => {
    const planned = [
      cursor({ model: 'composer-2.5' }),
      codex({ model: 'gpt-5.6-sol' }),
      claudeCode({ model: 'claude-haiku-4-5' }),
    ].map((h) => withDefaultEffort(h, EFFORTS))
    assert.deepEqual(effortNotes(planned, EFFORTS, ''), [
      "effort: cursor:composer-2.5 none (Cursor's model catalog lists no effort for composer-2.5)",
      'effort: claude-code:claude-haiku-4-5 none (Claude Code sends no effort to claude-haiku-4-5)',
      'efforts differ: none on cursor:composer-2.5, claude-code:claude-haiku-4-5; medium on codex:gpt-5.6-sol',
    ])
    assert.deepEqual(
      effortNotes([cursor({ model: 'composer-2.5' })], undefined, 'CURSOR_API_KEY is not set'),
      [
        "effort: cursor:composer-2.5 not checked against Cursor's model catalog (CURSOR_API_KEY is not set)",
      ],
    )
    const same = [codex({ model: 'a' }), pi({ model: 'gemini-3.8-flash' })].map((h) =>
      withDefaultEffort(h),
    )
    assert.deepEqual(effortNotes(same, undefined, ''), [])
  })
})

describe('the effort in the plan line and the run header', () => {
  test('one effort names it; mixed ones count the harnesses at each; fake alone has none', () => {
    assert.equal(effortSummary({ 'codex:a': 'medium', 'pi:b': 'medium' }), 'effort medium')
    assert.equal(
      effortSummary({ 'codex:a': 'medium', 'pi:b': 'medium', 'cursor:c': 'none', 'x:d': 'high' }),
      'efforts medium on 2 harnesses, none on 1, high on 1',
    )
    assert.equal(effortSummary({}), undefined)
  })

  test('a harness shows its effort unless its id already names it', () => {
    const lines = headerLines(
      colors(false, 4),
      {
        ...({} as RunHeader),
        version: '0.16.1',
        runId: 'r',
        dryRun: true,
        harnesses: ['codex:a', 'codex:a[effort=high]'],
        efforts: { 'codex:a': 'medium', 'codex:a[effort=high]': 'high' },
        sandboxes: ['docker'],
        judges: [],
        budget: {},
      },
      100,
    )
    assert.ok(lines.includes('  ➜  Harnesses: codex:a (effort: medium), codex:a[effort=high]'))
  })
})

describe("Cursor's model catalog at plan time", () => {
  test('finds the effort parameter by name, never an on/off toggle', () => {
    assert.equal(cursorEffortParam(CATALOG, 'gpt-5.6-luna')?.id, 'reasoning')
    assert.equal(cursorEffortParam(CATALOG, 'claude-opus-5')?.id, 'effort')
    assert.equal(cursorEffortParam(CATALOG, 'composer-2.5'), undefined)
  })

  test("refuses an effort or params the model doesn't take, saying what to change", () => {
    assert.equal(
      cursorCatalogProblem(
        cursor({ model: 'composer-2.5', effort: 'medium', params: { fast: 'false' } }),
        CATALOG,
      ),
      "Cursor's model catalog lists no effort for composer-2.5 (it takes fast ('false', 'true')), so drop cursor({ effort: 'medium' }); Fast is params.fast, not effort",
    )
    assert.equal(
      cursorCatalogProblem(cursor({ model: 'composer-2.5', params: { speed: 'x' } }), CATALOG),
      "cursor({ params }) sets speed, which Cursor's model catalog doesn't list for composer-2.5 (it takes fast ('false', 'true'))",
    )
    assert.equal(
      cursorCatalogProblem(cursor({ model: 'composer-2.5', params: { fast: 'yes' } }), CATALOG),
      "cursor({ params }) sets fast: 'yes', but composer-2.5 takes fast 'false', 'true'",
    )
    assert.equal(
      cursorCatalogProblem(cursor({ model: 'kimi-k3', effort: 'medium' }), CATALOG),
      "cursor({ effort }) on kimi-k3 is one of 'low', 'high', 'max' (got 'medium')",
    )
    assert.match(
      cursorCatalogProblem(cursor({ model: 'nope' }), CATALOG) ?? '',
      /has no model nope; name one it lists, e\.g\. 'composer-2\.5'/,
    )
    assert.equal(
      cursorCatalogProblem(cursor({ model: 'composer-2.5', params: { fast: 'false' } }), CATALOG),
      undefined,
    )
  })

  test('names the eval and cell that fail, and returns each model’s effort', () => {
    const attempt = (harness: ReturnType<typeof cursor>) => ({
      attempt: { name: 'fixes the bug', groups: ['api'], harness },
    })
    assert.throws(
      () =>
        checkCursorCatalog([attempt(cursor({ model: 'composer-2.5', effort: 'medium' }))], CATALOG),
      (e) =>
        e instanceof UsageError &&
        e.message.startsWith(
          'evaluate("api › fixes the bug") on cursor:composer-2.5[effort=medium]: ',
        ),
    )
    assert.deepEqual(
      checkCursorCatalog(
        [attempt(cursor({ model: 'composer-2.5' })), attempt(cursor({ model: 'gpt-5.6-luna' }))],
        CATALOG,
      ),
      {
        'composer-2.5': null,
        'gpt-5.6-luna': { param: 'reasoning', levels: ['low', 'medium', 'high'] },
      },
    )
  })

  test('reads the catalog again when its cached copy refuses a cell, and notes a failed read', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'reeval-cursor-catalog-'))
    const before = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = cache
    try {
      const reads: string[] = []
      const serving = (items: unknown[], status = 200): typeof fetch =>
        (async (url: string) => {
          reads.push(url)
          return new Response(JSON.stringify({ items }), { status })
        }) as typeof fetch
      const old = CATALOG.filter((m) => m.id !== 'gpt-5.6-luna')
      const luna = [
        { attempt: { name: 'e', groups: [], harness: cursor({ model: 'gpt-5.6-luna' }) } },
      ]
      const key = `key-${Date.now()}`
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
      mkdirSync(join(cache, 'reeval'))
      writeFileSync(
        join(cache, `reeval/cursor-models-${hash}.json`),
        JSON.stringify({ fetchedAt: new Date().toISOString(), items: old }),
      )
      assert.deepEqual(await checkCursorPlan(key, luna, { fetch: serving(CATALOG) }), {
        'gpt-5.6-luna': { param: 'reasoning', levels: ['low', 'medium', 'high'] },
      })
      assert.equal(reads.length, 1, 'the cached copy lacked gpt-5.6-luna, so it was read again')
      assert.deepEqual(await checkCursorPlan(key, luna, { fetch: serving([]) }), {
        'gpt-5.6-luna': { param: 'reasoning', levels: ['low', 'medium', 'high'] },
      })
      assert.equal(reads.length, 1, 'the fresh copy is cached')
      const failed = await checkCursorPlan(`other-${key}`, luna, { fetch: serving([], 401) })
      assert.ok(failed instanceof Error)
      assert.equal(failed.message, 'HTTP 401')
    } finally {
      if (before === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = before
      rmSync(cache, { recursive: true, force: true })
    }
  })
})
