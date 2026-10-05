// Transcript assertions: pass, fail, .not, expect matchers, and every replay skill
// capture through today's normaliser.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  calledSkill,
  calledTool,
  edited,
  fetched,
  ran,
  searched,
  assert as transcriptAssert,
} from '../src/assert.ts'
import { normaliseStream } from '../src/harness/transcript.ts'
import { toolCalls } from '../src/history/db.ts'
import { toolTarget } from '../src/history/tool-target.ts'
import { matchers } from '../src/matchers.ts'
import type { TranscriptEvent } from '../src/types.ts'
import { testDir } from './support/fixture.ts'

const at = { ts: '2026-10-05T12:00:00.000Z', atMs: 0, durationMs: 1 }

const tool = (
  name: string,
  input: unknown,
  output: unknown = 'ok',
): Extract<TranscriptEvent, { type: 'tool' }> => ({
  ...at,
  type: 'tool',
  toolCallId: `call_${name}`,
  tool: name,
  input,
  output,
  ok: true,
})

const edit = (
  path: string,
  kind: 'create' | 'modify' | 'delete' = 'modify',
): Extract<TranscriptEvent, { type: 'file-edit' }> => ({
  ...at,
  type: 'file-edit',
  toolCallId: `edit_${path}`,
  path,
  kind,
  added: 1,
  removed: 0,
})

const turnOf = (
  transcript: TranscriptEvent[],
  unreported: Array<'web-search' | 'web-fetch'> = [],
) => ({
  transcript,
  unreported,
})

const throws = (fn: () => void, message: RegExp | string) => {
  assert.throws(fn, (e: Error) => {
    assert.equal(e.name, 'AssertionError')
    if (typeof message === 'string') assert.equal(e.message, message)
    else assert.match(e.message, message)
    return true
  })
}

describe('calledSkill', () => {
  test('passes on a dedicated load tool by id or name', () => {
    assert.equal(calledSkill(turnOf([tool('skill', { id: 'foo' })]), 'foo').pass, true)
    assert.equal(calledSkill(turnOf([tool('Skill', { name: 'foo' })]), 'foo').pass, true)
    assert.equal(calledSkill(turnOf([tool('load_skill', { name: 'foo' })]), 'foo').pass, true)
  })

  test('passes when a tool target contains skills/<name>/', () => {
    const read = turnOf([tool('read', { path: '/home/reeval/.agents/skills/foo/SKILL.md' })])
    const sed = turnOf([tool('bash', { command: "sed -n '1,40p' ~/.agents/skills/foo/SKILL.md" })])
    assert.equal(calledSkill(read, 'foo').pass, true)
    assert.equal(calledSkill(sed, 'foo').pass, true)
  })

  test('fails naming the skill-like calls it saw', () => {
    const t = turnOf([
      tool('skill', { id: 'house-greeting' }),
      tool('read', { path: '~/.agents/skills/other/SKILL.md' }),
      tool('bash', { command: 'echo hi' }),
    ])
    const r = calledSkill(t, 'foo')
    assert.equal(r.pass, false)
    assert.equal(
      r.message(),
      'expected skill-like calls matching foo, got ["skill:house-greeting","read ~/.agents/skills/other/SKILL.md"]',
    )
  })

  test('assert().not.calledSkill is the activation negative', () => {
    const t = turnOf([tool('skill', { id: 'foo' })])
    transcriptAssert(t).calledSkill('foo')
    throws(
      () => transcriptAssert(t).not.calledSkill('foo'),
      /expected no skill-like calls matching foo/,
    )
    transcriptAssert(t).not.calledSkill('bar')
  })
})

describe('calledTool', () => {
  test('matches type: tool only, by exact name or RegExp', () => {
    const t = turnOf([tool('mcp__stamp__house_stamp', { args: {} }), edit('notes.txt')])
    assert.equal(calledTool(t, 'mcp__stamp__house_stamp').pass, true)
    assert.equal(calledTool(t, /^mcp__stamp__/).pass, true)
    assert.equal(calledTool(t, 'edit').pass, false)
    assert.equal(calledTool(t, 'mcp__stamp__other').pass, false)
  })

  test('optional input is a substring, RegExp, or object', () => {
    const t = turnOf([tool('bash', { command: 'echo contract-42' })])
    assert.equal(calledTool(t, 'bash', 'contract-42').pass, true)
    assert.equal(calledTool(t, 'bash', /contract-\d+/).pass, true)
    assert.equal(calledTool(t, 'bash', { command: 'echo contract-42' }).pass, true)
    assert.equal(calledTool(t, 'bash', { command: /42/ }).pass, true)
    assert.equal(calledTool(t, 'bash', 'deploy').pass, false)
  })

  test('fails naming the tools it saw', () => {
    const t = turnOf([tool('mcp__stamp__house_stamp', {})])
    const r = calledTool(t, 'mcp__stamp__other')
    assert.equal(r.pass, false)
    assert.equal(
      r.message(),
      'expected tool calls matching mcp__stamp__other, got ["mcp__stamp__house_stamp"]',
    )
  })
})

describe('ran', () => {
  test('matches bash or shell, and an optional command', () => {
    const bash = turnOf([tool('bash', { command: 'echo contract-42' })])
    const shell = turnOf([tool('shell', { command: 'echo contract-42' })])
    const other = turnOf([tool('read', { path: 'notes.txt' })])
    assert.equal(ran(bash).pass, true)
    assert.equal(ran(shell, /contract-42/).pass, true)
    assert.equal(ran(bash, 'deploy').pass, false)
    assert.equal(ran(other).pass, false)
  })
})

describe('edited', () => {
  test('matches a file-edit, or a tool that names the path', () => {
    const file = turnOf([edit('notes.txt')])
    const shell = turnOf([tool('bash', { command: 'echo x > notes.txt' }, 'wrote notes.txt')])
    assert.equal(edited(file, 'notes.txt').pass, true)
    assert.equal(edited(file).pass, true)
    assert.equal(edited(shell, 'notes.txt').pass, true)
    assert.equal(edited(file, 'other.txt').pass, false)
  })
})

describe('searched and fetched', () => {
  const web = turnOf([
    {
      ...at,
      type: 'web-fetch',
      toolCallId: 'f',
      url: 'https://httpbin.org/ip',
      ok: true,
    },
    {
      ...at,
      type: 'web-search',
      toolCallId: 's',
      query: 'IANA example domain RFC 2606',
      references: 2,
    },
  ])

  test('wrap the existing web matchers, including on c', () => {
    assert.equal(fetched(web, 'httpbin.org').pass, true)
    assert.equal(searched(web, /RFC 2606/).pass, true)
    const c = { turns: [web] }
    assert.equal(fetched(c, 'httpbin.org').pass, true)
    transcriptAssert(c).fetched('httpbin.org')
  })

  test("refuse a turn whose harness doesn't report them", () => {
    const cursor = turnOf([], ['web-search', 'web-fetch'])
    assert.throws(
      () => fetched(cursor, 'httpbin'),
      (e: Error) => {
        assert.equal(e.name, 'HarnessCapabilityError')
        return true
      },
    )
  })
})

describe('assert() and expect matchers', () => {
  test('throw AssertionError, and the expect wrappers share the predicates', () => {
    const t = turnOf([tool('skill', { id: 'foo' })])
    transcriptAssert(t).calledSkill('foo')
    throws(() => transcriptAssert(t).calledSkill('bar'), /expected skill-like calls matching bar/)
    assert.equal(matchers.toHaveCalledSkill(t, 'foo').pass, true)
    assert.equal(matchers.toHaveCalledSkill(t, 'bar').pass, false)
    assert.throws(() => transcriptAssert({}), /expects a turn from c.send\(\), or c/)
  })

  test('reads every turn on c', () => {
    const first = turnOf([tool('read', { path: '~/.agents/skills/foo/SKILL.md' })])
    const second = turnOf([tool('mcp__stamp__house_stamp', {})])
    const c = { turns: [first, second] }
    transcriptAssert(c).calledSkill('foo').calledTool('mcp__stamp__house_stamp')
    throws(() => transcriptAssert(first).calledTool('mcp__stamp__house_stamp'), /got none/)
  })
})

describe('toolTarget and toolCalls', () => {
  test('a dedicated skill load stores the skill name as the target', () => {
    assert.equal(toolTarget({ id: 'house-greeting' }, 'skill'), 'house-greeting')
    assert.equal(toolTarget({ name: 'house-greeting' }, 'load_skill'), 'house-greeting')
    assert.equal(toolTarget({ path: 'notes.txt' }, 'read'), 'notes.txt')
    const calls = toolCalls(
      `${JSON.stringify({ type: 'tool', tool: 'skill', input: { id: 'foo' } })}\n`,
    )
    assert.deepEqual(
      calls.map((c) => [c.tool, c.target]),
      [['skill', 'foo']],
    )
  })
})

const replayRoot = join(testDir, 'replay')
const harnesses = existsSync(replayRoot)
  ? readdirSync(replayRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'formats')
      .map((d) => d.name)
      .sort()
  : []

const replay = (harness: string, file: string) => {
  const lines = readFileSync(join(replayRoot, harness, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { ms: number; part: { type: string; [k: string]: unknown } })
  return turnOf(
    normaliseStream(
      lines.map((l) => ({ ms: l.ms, part: l.part as never })),
      0,
    ),
  )
}

describe('replay captures through normaliseStream', () => {
  test('there are skill and mcp captures for each harness', () => {
    assert.deepEqual(harnesses, ['antigravity', 'codex', 'cursor', 'goose', 'opencode', 'pi'])
  })

  for (const harness of harnesses) {
    test(`${harness} skill.raw.jsonl: calledSkill('contract-probe')`, () => {
      const t = replay(harness, 'skill.raw.jsonl')
      transcriptAssert(t).calledSkill('contract-probe')
      throws(() => transcriptAssert(t).calledSkill('no-such-skill'), /expected skill-like calls/)
    })

    test(`${harness} mcp.raw.jsonl: calledTool('mcp__stamp__house_stamp')`, () => {
      const t = replay(harness, 'mcp.raw.jsonl')
      transcriptAssert(t).calledTool('mcp__stamp__house_stamp')
      throws(
        () => transcriptAssert(t).calledTool('mcp__stamp__other'),
        /expected tool calls matching mcp__stamp__other/,
      )
    })

    test(`${harness} edit-and-run.raw.jsonl: ran and edited`, () => {
      const t = replay(harness, 'edit-and-run.raw.jsonl')
      transcriptAssert(t)
        .ran(/contract/)
        .edited('notes.txt')
      throws(() => transcriptAssert(t).ran(/deploy/), /expected shell commands matching \/deploy\//)
    })
  }
})
