// The matchers fixtures assert with: pass, fail, and the message a failure shows.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { matchers } from '../src/matchers.ts'
import type { Verdict } from '../src/types.ts'

const files = (content: Record<string, string>) => ({
  readFile: async (path: string) => content[path] ?? null,
})

describe('toHaveFile', () => {
  const t = files({ 'a.txt': 'hello\nworld\n' })

  test('passes when the file exists, with or without a matching pattern', async () => {
    assert.equal((await matchers.toHaveFile(t, 'a.txt')).pass, true)
    assert.equal((await matchers.toHaveFile(t, 'a.txt', /wor/)).pass, true)
    assert.equal((await matchers.toHaveFile(t, 'a.txt', 'hello')).pass, true)
  })

  test('fails on a missing file, naming it', async () => {
    const r = await matchers.toHaveFile(t, 'missing.txt', /x/)
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'expected file missing.txt to exist')
  })

  test("fails when the content doesn't match, showing the pattern and the file's tail", async () => {
    const r = await matchers.toHaveFile(t, 'a.txt', /nope/)
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'expected a.txt to match /nope/\n--- a.txt ---\nhello\nworld')
  })

  test('the negated message says "not"', async () => {
    const r = await matchers.toHaveFile(t, 'a.txt', 'hello')
    assert.equal(r.message(), 'expected a.txt not to match hello\n--- a.txt ---\nhello\nworld')
  })

  test('rejects something that has no files', async () => {
    await assert.rejects(matchers.toHaveFile({}, 'a.txt'), /toHaveFile\(\) expects a turn/)
  })
})

describe('toSucceed', () => {
  test('passes on exit 0', async () => {
    const r = await matchers.toSucceed(Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }))
    assert.equal(r.pass, true)
    assert.equal(r.message(), 'expected command to fail')
  })

  test('fails on another exit code, with stderr and stdout tails', async () => {
    const r = await matchers.toSucceed({ exitCode: 2, stdout: 'out\n', stderr: 'err\n' })
    assert.equal(r.pass, false)
    assert.equal(
      r.message(),
      'expected command to succeed, exit code 2\n--- stderr ---\nerr\n--- stdout ---\nout',
    )
  })

  test('keeps only the last 20 lines of each stream', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const r = await matchers.toSucceed({ exitCode: 1, stdout: '', stderr: lines })
    assert.match(r.message(), /--- stderr ---\nline 11\n[\s\S]*line 30\n--- stdout ---/)
    assert.doesNotMatch(r.message(), /line 10\n/)
  })

  test('rejects something that is not an exec result', async () => {
    await assert.rejects(matchers.toSucceed('nope'), /toSucceed\(\) expects run\.exec/)
  })
})

describe('toPass', () => {
  const verdict = (over: Partial<Verdict>): Verdict =>
    ({
      verdict: 'pass',
      score: 0.9,
      threshold: 0.8,
      question: 'Is it polite?',
      model: 'fake/judge',
      ...over,
    }) as Verdict

  test('passes on a pass verdict, with a negated message', () => {
    const r = matchers.toPass(verdict({}))
    assert.equal(r.pass, true)
    assert.equal(r.message(), 'expected judge to fail: score 0.90 ≥ 0.8 for "Is it polite?"')
  })

  test('fails below the threshold, naming the score, question and model', () => {
    const r = matchers.toPass(verdict({ verdict: 'fail', score: 0.4 }))
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'judge score 0.40 is below 0.8 for "Is it polite?" (fake/judge)')
  })

  test('rejects something that is not a verdict', () => {
    assert.throws(() => matchers.toPass({}), /toPass\(\) expects a t\.judge\(\) verdict/)
  })
})

describe('toHaveFetched and toHaveSearched', () => {
  const at = { ts: '2026-09-26T17:04:55.000Z', atMs: 0, durationMs: 950 }
  const turn = (unreported: Array<'web-search' | 'web-fetch'> = []) => ({
    unreported,
    transcript: [
      {
        ...at,
        type: 'web-fetch' as const,
        toolCallId: 'f',
        url: 'https://httpbin.org/ip',
        ok: true,
      },
      {
        ...at,
        type: 'web-search' as const,
        toolCallId: 's',
        query: 'IANA example domain RFC 2606',
        references: 2,
      },
    ],
  })

  test('pass on a matching event, by substring or pattern, or on any event with none given', () => {
    assert.equal(matchers.toHaveFetched(turn(), 'httpbin.org').pass, true)
    assert.equal(matchers.toHaveFetched(turn(), /\/ip$/).pass, true)
    assert.equal(matchers.toHaveFetched(turn()).pass, true)
    assert.equal(matchers.toHaveSearched(turn(), /RFC 2606/).pass, true)
  })

  test('fail naming what the turn did fetch or search', () => {
    const r = matchers.toHaveFetched(turn(), 'example.com')
    assert.equal(r.pass, false)
    assert.equal(
      r.message(),
      'expected web fetches matching example.com, got ["https://httpbin.org/ip"]',
    )
    const none = matchers.toHaveSearched({ unreported: [], transcript: [] })
    assert.equal(none.message(), 'expected web searches, got none')
  })

  test("refuse a turn whose harness doesn't report them, negated or not: never a silent pass", () => {
    const cursor = { unreported: ['web-search', 'web-fetch'] as const, transcript: [] }
    for (const check of [
      () => matchers.toHaveFetched({ ...cursor, unreported: [...cursor.unreported] }, 'httpbin'),
      () => matchers.toHaveSearched({ ...cursor, unreported: [...cursor.unreported] }),
    ]) {
      assert.throws(check, (e: Error) => {
        assert.equal(e.name, 'HarnessCapabilityError')
        assert.match(
          e.message,
          /doesn't report web (fetches|searches) \('web-(fetch|search)' is in turn\.unreported\)/,
        )
        return true
      })
    }
    // Only the unreported type is refused.
    assert.equal(matchers.toHaveSearched(turn(['web-fetch']), 'RFC').pass, true)
  })

  test('reject something that is not a turn', () => {
    assert.throws(() => matchers.toHaveFetched({}), /toHaveFetched\(\) expects a turn/)
  })
})
