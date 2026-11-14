// Transcript matchers: pass, fail, .not, every replay skill capture through
// today's normalizer, and each harness's captured skill use.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SKILL_DIRS } from '@reeval/agents/layouts'
import {
  calledMcp,
  calledSkill,
  calledTool,
  changed,
  edited,
  fetched,
  isMisuse,
  limitsLabel,
  ran,
  runMatchLabel,
  searched,
  TURN_EDITED,
  withinLimits,
} from '../src/assert.ts'
import { expect, extendExpect } from '../src/engine/expect.ts'
import { AGENTS, type AgentKind } from '../src/harness/agents.ts'
import { normalizeStream } from '../src/harness/transcript.ts'
import { classifyCall, skillsUsed } from '../src/history/tool-class.ts'
import { toolTarget } from '../src/history/tool-target.ts'
import { matchers } from '../src/matchers.ts'
import type { TranscriptEvent } from '../src/types.ts'
import { toolCalls } from '../src/view/classify.ts'
import { transcriptByLine } from '../src/view/model.ts'
import { testDir } from './support/fixture.ts'

extendExpect(matchers)

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
    if (typeof message === 'string') assert.ok(e.message.includes(message), e.message)
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

  test('expect().not.toHaveCalledSkill is the activation negative', () => {
    const t = turnOf([tool('skill', { id: 'foo' })])
    expect(t).toHaveCalledSkill('foo')
    throws(
      () => expect(t).not.toHaveCalledSkill('foo'),
      /expected no skill-like calls matching foo/,
    )
    expect(t).not.toHaveCalledSkill('bar')
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

describe('calledMcp', () => {
  test('joins server and tool into mcp__<server>__<tool>', () => {
    const t = turnOf([tool('mcp__stamp__house_stamp', { args: {} }), edit('notes.txt')])
    assert.equal(calledMcp(t, 'stamp', 'house_stamp').pass, true)
    assert.equal(calledMcp(t, 'stamp', 'other').pass, false)
    assert.equal(calledMcp(t, 'other', 'house_stamp').pass, false)
  })

  test('optional input is the same match as calledTool', () => {
    const t = turnOf([tool('mcp__stamp__house_stamp', { query: 'contract-42' })])
    assert.equal(calledMcp(t, 'stamp', 'house_stamp', 'contract-42').pass, true)
    assert.equal(calledMcp(t, 'stamp', 'house_stamp', /contract-\d+/).pass, true)
    assert.equal(calledMcp(t, 'stamp', 'house_stamp', { query: 'contract-42' }).pass, true)
    assert.equal(calledMcp(t, 'stamp', 'house_stamp', { query: /42/ }).pass, true)
    assert.equal(calledMcp(t, 'stamp', 'house_stamp', 'deploy').pass, false)
  })

  test('fails listing MCP calls as server/tool', () => {
    const t = turnOf([tool('mcp__stamp__house_stamp', {}), tool('bash', { command: 'echo hi' })])
    const r = calledMcp(t, 'stamp', 'other')
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'expected MCP calls matching stamp/other, got ["stamp/house_stamp"]')
  })

  test('expect().not.toHaveCalledMcp is the negative', () => {
    const t = turnOf([tool('mcp__stamp__house_stamp', {})])
    expect(t).toHaveCalledMcp('stamp', 'house_stamp')
    throws(
      () => expect(t).not.toHaveCalledMcp('stamp', 'house_stamp'),
      /expected no MCP calls matching stamp\/house_stamp/,
    )
    expect(t).not.toHaveCalledMcp('stamp', 'other')
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

  test('a string or RegExp still matches the whole command line', () => {
    const t = turnOf([tool('bash', { command: 'cat genkit.config.ts' })])
    assert.equal(ran(t, 'genkit').pass, true)
    assert.equal(ran(t, /genkit/).pass, true)
    assert.equal(ran(t, { program: 'genkit' }).pass, false)
  })

  test('{ program } matches the program a segment ran, after its wrappers', () => {
    const t = turnOf([
      tool('bash', { command: 'cd app && FOO=1 npx -y genkit@latest flow:run x' }),
      tool('shell', { command: 'npm i genkit; ./node_modules/.bin/skills add y' }),
    ])
    assert.equal(ran(t, { program: 'genkit' }).pass, true)
    assert.equal(ran(t, { program: 'genkit', args: /^flow:run\b/ }).pass, true)
    assert.equal(ran(t, { program: 'genkit', args: 'flow:run x' }).pass, true)
    assert.equal(ran(t, { program: /^gen/, args: 'x' }).pass, true)
    assert.equal(ran(t, { program: 'skills', args: /^add\b/ }).pass, true)
    assert.equal(ran(t, { program: 'genkit', args: /^start\b/ }).pass, false)
    assert.equal(ran(t, { program: 'npx' }).pass, false)
    assert.equal(ran(t, { program: 'npm', args: /^i\b/ }).pass, true)
  })

  test('{ program } fails listing every program run, and .not lists the matching ones', () => {
    const t = turnOf([tool('bash', { command: 'npm i genkit && npx genkit start' })])
    assert.equal(
      ran(t, { program: 'genkit', args: /^flow:run\b/ }).message(),
      'expected runs of genkit with args matching /^flow:run\\b/, got ["npm i genkit","genkit start"]',
    )
    expect(t).toHaveRun({ program: 'genkit' })
    throws(
      () => expect(t).not.toHaveRun({ program: 'genkit' }),
      'expected no runs of genkit, got ["genkit start"]',
    )
  })

  test('{ program } is checked: its keys, its program and its args', () => {
    const t = turnOf([tool('bash', { command: 'genkit start' })])
    const misuse = (match: unknown, message: RegExp) =>
      assert.throws(
        () => ran(t, match as never),
        (e: Error) => isMisuse(e) && message.test(e.message),
      )
    misuse({ program: 'genkit', arg: 'start' }, /has no "arg"; .* Did you mean "args"\?/)
    misuse({ args: 'start' }, /program is a program name or a regular expression/)
    misuse({ program: '' }, /program is a program name/)
    misuse({ program: 'genkit', args: ['start'] }, /args is text or a regular expression/)
  })

  test('runMatchLabel names the program and its args', () => {
    assert.equal(
      runMatchLabel({ program: 'genkit', args: /^flow:run\b/ }),
      'program genkit args /^flow:run\\b/',
    )
    assert.equal(runMatchLabel({ program: /gen/ }), 'program /gen/')
    assert.equal(runMatchLabel('genkit'), undefined)
    assert.equal(runMatchLabel(/genkit/), undefined)
  })
})

describe('edited', () => {
  const withDiff = (transcript: TranscriptEvent[], ...paths: string[]) => ({
    ...turnOf(transcript),
    diff: { patch: '', files: paths.map((path) => ({ path, status: 'added' as const })) },
  })
  const heredoc = tool('bash', { command: "cat <<'EOF' > notes.txt\nhello\nEOF" }, '')

  test('matches a file-edit, or a file in the workspace diff', () => {
    const file = turnOf([edit('notes.txt')])
    const shell = withDiff([heredoc], 'notes.txt')
    assert.equal(edited(file, 'notes.txt').pass, true)
    assert.equal(edited(file).pass, true)
    assert.equal(edited(shell, 'notes.txt').pass, true)
    assert.equal(edited(shell).pass, true)
    assert.equal(edited(file, 'other.txt').pass, false)
    assert.equal(edited(shell, /^other/).pass, false)
  })

  test("doesn't count a tool that only names the path", () => {
    const read = withDiff([tool('bash', { command: 'cat notes.txt' }, 'hello')])
    assert.equal(edited(read, 'notes.txt').pass, false)
    assert.equal(edited(read).pass, false)
    assert.equal(edited(turnOf([heredoc]), 'notes.txt').pass, false)
    expect(read).not.toHaveEdited('notes.txt')
  })

  test('reads the files the turn changed, not its cumulative diff', () => {
    const first = { ...withDiff([heredoc], 'notes.txt'), [TURN_EDITED]: ['notes.txt'] }
    const second = { ...withDiff([], 'notes.txt'), [TURN_EDITED]: [] }
    expect(first).toHaveEdited('notes.txt')
    expect(second).not.toHaveEdited('notes.txt')
    expect({ turns: [first, second] }).toHaveEdited('notes.txt')
    assert.equal(edited({ turns: [] }).pass, false)
  })

  test('names the files it saw, once', () => {
    throws(
      () => expect(withDiff([edit('notes.txt')], 'notes.txt', 'a.txt')).toHaveEdited('b.txt'),
      'expected file edits matching b.txt, got ["notes.txt","a.txt"]',
    )
    throws(
      () => expect(withDiff([heredoc], 'notes.txt')).not.toHaveEdited('notes.txt'),
      'expected no file edits matching notes.txt, got ["notes.txt"]',
    )
  })
})

describe('changed', () => {
  const diffOf = (...files: Array<[string, 'added' | 'modified' | 'deleted']>) => ({
    ...turnOf([]),
    diff: { patch: '', files: files.map(([path, status]) => ({ path, status })) },
  })
  const turn = diffOf(['test/greet.test.js', 'modified'], ['src/greet.ts', 'added'])

  test('matches the diff with globs, directories, RegExps and lists', () => {
    assert.equal(changed(turn, 'test/**').pass, true)
    assert.equal(changed(turn, 'test').pass, true)
    assert.equal(changed(turn, './test/').pass, true)
    assert.equal(changed(turn, 'src/greet.ts').pass, true)
    assert.equal(changed(turn, /\.test\.js$/).pass, true)
    assert.equal(changed(turn, ['tsconfig.json', 'src/*.ts']).pass, true)
    assert.equal(changed(turn).pass, true)
    assert.equal(changed(turn, 'greet.ts').pass, false)
    assert.equal(changed(turn, ['tsconfig.json', 'biome.json']).pass, false)
    assert.equal(changed(diffOf()).pass, false)
  })

  test('reads c as of its latest turn, and nothing before one', () => {
    assert.equal(changed({ turns: [diffOf(), turn] }, 'test/**').pass, true)
    assert.equal(changed({ turns: [turn, diffOf()] }, 'test/**').pass, false)
    assert.equal(changed({ turns: [] }).pass, false)
    expect({ turns: [turn] }).toHaveChanged('src/**')
  })

  test('names the files it saw', () => {
    throws(
      () => expect(turn).not.toHaveChanged('test/**'),
      'expected no changes to test/**, got ["test/greet.test.js" (modified)]',
    )
    throws(
      () => expect(turn).not.toHaveChanged(['tsconfig.json', /greet/]),
      'expected no changes to tsconfig.json, /greet/, got ["test/greet.test.js" (modified), "src/greet.ts" (added)]',
    )
    throws(
      () => expect(turn).toHaveChanged('package.json'),
      'expected changes to package.json, got ["test/greet.test.js" (modified), "src/greet.ts" (added)]',
    )
    throws(() => expect(diffOf()).toHaveChanged(), 'expected changes, got none')
    throws(
      () => expect({} as never).toHaveChanged('x'),
      'toHaveChanged() expects a turn from c.send(), or c',
    )
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
    expect(c).toHaveFetched('httpbin.org')
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

describe('expect matchers', () => {
  test('throw, and the expect wrappers share the predicates', () => {
    const t = turnOf([tool('skill', { id: 'foo' })])
    expect(t).toHaveCalledSkill('foo')
    throws(() => expect(t).toHaveCalledSkill('bar'), /expected skill-like calls matching bar/)
    assert.equal(matchers.toHaveCalledSkill(t, 'foo').pass, true)
    assert.equal(matchers.toHaveCalledSkill(t, 'bar').pass, false)
    assert.throws(
      () => expect({} as never).toHaveCalledSkill('foo'),
      /toHaveCalledSkill\(\) expects a turn from c.send\(\), or c/,
    )
    assert.throws(
      () => expect({} as never).toHaveCalledMcp('stamp', 'house_stamp'),
      /toHaveCalledMcp\(\) expects a turn from c.send\(\), or c/,
    )
  })

  test('reads every turn on c', () => {
    const first = turnOf([tool('read', { path: '~/.agents/skills/foo/SKILL.md' })])
    const second = turnOf([tool('mcp__stamp__house_stamp', {})])
    const c = { turns: [first, second] }
    expect(c).toHaveCalledSkill('foo')
    expect(c).toHaveCalledMcp('stamp', 'house_stamp')
    expect(c).toHaveCalledTool('mcp__stamp__house_stamp')
    throws(
      () => expect(first).toHaveCalledMcp('stamp', 'house_stamp'),
      /expected MCP calls matching stamp\/house_stamp, got none/,
    )
    throws(
      () => expect(first).toHaveCalledTool('mcp__stamp__house_stamp'),
      /expected tool calls matching mcp__stamp__house_stamp, got \["read"\]/,
    )
  })
})

describe('toolTarget and toolCalls', () => {
  test('a dedicated skill load stores the skill name as the target', () => {
    assert.equal(toolTarget({ id: 'house-greeting' }, 'skill'), 'house-greeting')
    assert.equal(toolTarget({ name: 'house-greeting' }, 'load_skill'), 'house-greeting')
    assert.equal(toolTarget({ path: 'notes.txt' }, 'read'), 'notes.txt')
    const calls = toolCalls(
      transcriptByLine(
        `${JSON.stringify({ type: 'tool', tool: 'skill', input: { id: 'foo' } })}\n`,
      ),
    )
    assert.deepEqual(
      calls.map((c) => [c.tool, c.target]),
      [['skill', 'foo']],
    )
  })

  test('a call the harness never reported a result for is neither ok nor failed', () => {
    const lines = [
      { type: 'tool', tool: 'read', input: { path: 'a' }, ok: true },
      { type: 'tool', tool: 'read', input: { path: 'b' }, ok: false },
      { type: 'tool', tool: 'read', input: { path: 'c' }, ok: null },
      { type: 'tool', tool: 'read', input: { path: 'd' } },
    ]
    assert.deepEqual(
      toolCalls(transcriptByLine(lines.map((l) => JSON.stringify(l)).join('\n'))).map((c) => [
        c.target,
        c.ok,
      ]),
      [
        ['a', true],
        ['b', false],
        ['c', null],
        ['d', true],
      ],
    )
  })
})

const replayRoot = join(testDir, 'replay')
const harnesses = existsSync(replayRoot)
  ? readdirSync(replayRoot, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          d.name !== 'formats' &&
          d.name !== 'telemetry' &&
          d.name !== 'model-calls',
      )
      .map((d) => d.name)
      .sort()
  : []

const replay = (harness: string, file: string) => {
  const lines = readFileSync(join(replayRoot, harness, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { ms: number; part: { type: string; [k: string]: unknown } })
  return turnOf(
    normalizeStream(
      lines.map((l) => ({ ms: l.ms, part: l.part as never })),
      0,
    ),
  )
}

describe('replay captures through normalizeStream', () => {
  test('there are skill and mcp captures for each harness', () => {
    assert.deepEqual(harnesses, [
      'antigravity',
      'codex',
      'cursor',
      'fx',
      'goose',
      'grok-build',
      'opencode',
      'pi',
    ])
  })

  for (const harness of harnesses) {
    test(`${harness} skill.raw.jsonl: toHaveCalledSkill('contract-probe')`, () => {
      const t = replay(harness, 'skill.raw.jsonl')
      expect(t).toHaveCalledSkill('contract-probe')
      throws(() => expect(t).toHaveCalledSkill('no-such-skill'), /expected skill-like calls/)
    })

    test(`${harness} mcp.raw.jsonl: toHaveCalledMcp('stamp', 'house_stamp')`, () => {
      const t = replay(harness, 'mcp.raw.jsonl')
      expect(t).toHaveCalledMcp('stamp', 'house_stamp')
      expect(t).toHaveCalledTool('mcp__stamp__house_stamp')
      throws(
        () => expect(t).toHaveCalledMcp('stamp', 'other'),
        /expected MCP calls matching stamp\/other/,
      )
      throws(
        () => expect(t).toHaveCalledTool('mcp__stamp__other'),
        /expected tool calls matching mcp__stamp__other/,
      )
    })

    test(`${harness} edit-and-run.raw.jsonl: toHaveRun and toHaveEdited`, () => {
      const t = replay(harness, 'edit-and-run.raw.jsonl')
      expect(t).toHaveRun(/contract/)
      expect(t).toHaveRun({ program: 'echo', args: /^contract-/ })
      expect(t).toHaveEdited('notes.txt')
      throws(() => expect(t).toHaveRun(/deploy/), /expected shell commands matching \/deploy\//)
    })
  }
})

const CLAUDE_CODE_SKILL =
  'fixtures/records/real-contract/evals/.history/20260929T033538Z_nogit_runner_f3z3/evals-skill-eval-ts-skill-468cc8/claude-code-claude-haiku-4-5-skilled-docker-7add5d/1/transcript.jsonl'

/** Each harness's use of the contract's `contract-probe` skill, as its capture has it. */
const SKILL_USES: Record<AgentKind, { from: string; tool: string; input: unknown }> = {
  cursor: {
    from: 'replay/cursor/skill.raw.jsonl',
    tool: 'read',
    input: { path: '/home/reeval/.agents/skills/contract-probe/SKILL.md' },
  },
  'claude-code': { from: CLAUDE_CODE_SKILL, tool: 'Skill', input: { skill: 'contract-probe' } },
  antigravity: {
    from: 'replay/antigravity/skill.raw.jsonl',
    tool: 'read',
    input: {
      file_path: '/home/reeval/.gemini/config/skills/contract-probe/SKILL.md',
      Path: '/home/reeval/.gemini/config/skills/contract-probe/SKILL.md',
    },
  },
  opencode: {
    from: 'replay/opencode/skill.raw.jsonl',
    tool: 'skill',
    input: { id: 'contract-probe' },
  },
  goose: {
    from: 'replay/goose/skill.raw.jsonl',
    tool: 'load_skill',
    input: { name: 'contract-probe' },
  },
  pi: {
    from: 'replay/pi/skill.raw.jsonl',
    tool: 'read',
    input: { path: '/home/reeval/.pi/agent/skills/contract-probe/SKILL.md', limit: 100, offset: 1 },
  },
  codex: {
    from: 'replay/codex/skill.raw.jsonl',
    tool: 'bash',
    input: {
      command: `/bin/bash -lc "sed -n '1,240p' /home/reeval/.agents/skills/contract-probe/SKILL.md"`,
    },
  },
  fx: {
    from: 'replay/fx/skill.raw.jsonl',
    tool: 'skill',
    input: { location: 'skill:61ce5ec8bc2106bf:0/contract-probe', name: 'contract-probe' },
  },
  'grok-build': {
    from: 'replay/grok-build/skill.raw.jsonl',
    tool: 'read_file',
    input: {
      target_file:
        '/home/reeval/.ai-sdk-harness/.harness-bootstrap/grok-build/home/.grok/skills/contract-probe/SKILL.md',
    },
  },
}

/** A capture's normalized tool calls: a replay stream through normalizeStream, or a transcript. */
const capturedTools = (from: string) => {
  const text = readFileSync(join(testDir, from), 'utf8')
  const events = from.endsWith('.raw.jsonl')
    ? normalizeStream(
        text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .map((l) => ({ ms: l.ms, part: l.part as never })),
        0,
      )
    : (text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)) as TranscriptEvent[])
  return events.flatMap((e) => (e.type === 'tool' ? [{ tool: e.tool, input: e.input }] : []))
}

describe("every harness's skill use", () => {
  test('there is a row for each harness in the catalog', () => {
    assert.deepEqual(Object.keys(SKILL_USES).sort(), Object.keys(AGENTS).sort())
  })

  for (const [harness, use] of Object.entries(SKILL_USES)) {
    test(`${harness}: the row is in ${use.from}`, () => {
      assert.ok(
        capturedTools(use.from).some(
          (t) => t.tool === use.tool && JSON.stringify(t.input) === JSON.stringify(use.input),
        ),
      )
    })

    test(`${harness}: toHaveCalledSkill, skill_reads and the context class all see it`, () => {
      const t = turnOf([tool(use.tool, use.input)])
      expect(t).toHaveCalledSkill('contract-probe')
      expect(t).not.toHaveCalledSkill('contract')
      expect(t).not.toHaveCalledSkill('probe')
      const [call] = toolCalls(
        transcriptByLine(JSON.stringify({ type: 'tool', tool: use.tool, input: use.input })),
      )
      assert.ok(call)
      assert.deepEqual(skillsUsed(call.tool, call.text, ['other', 'contract-probe']), [
        'contract-probe',
      ])
      assert.ok(!call.target.startsWith('{'), `${call.target} is a named input, not the JSON`)
      const ctx = {
        skills: ['contract-probe'],
        skillDirs: SKILL_DIRS,
        files: [],
        mcp: [],
        verify: [],
      }
      assert.equal(classifyCall(call.tool, call.text, ctx).class, 'context')
    })
  }

  test("Claude Code's plugin skill is <plugin>:<name>", () => {
    const t = turnOf([tool('Skill', { skill: 'house:contract-probe' })])
    expect(t).toHaveCalledSkill('contract-probe')
    expect(t).toHaveCalledSkill('house:contract-probe')
    expect(t).not.toHaveCalledSkill('house')
  })

  test('a shell command that cds into the skill reads it; one that excludes it does not', () => {
    const cd = turnOf([tool('bash', { command: 'cd ~/.agents/skills/foo && cat SKILL.md' })])
    expect(cd).toHaveCalledSkill('foo')
    expect(cd).not.toHaveCalledSkill('foo-bar')
    const excluded = turnOf([tool('bash', { command: 'rg -n todo --glob "!skills/foo/**"' })])
    expect(excluded).not.toHaveCalledSkill('foo')
    const tested = turnOf([tool('bash', { command: '[ -d ~/.agents/skills/foo ] && echo yes' })])
    expect(tested).not.toHaveCalledSkill('foo')
  })
})

describe('toStayWithin', () => {
  const usage = { input: 900, output: 100, cacheRead: 50, cacheWrite: 0, reasoning: null }
  const budgetTurn = (
    transcript: TranscriptEvent[],
    durationMs = 1000,
    u: typeof usage | null = usage,
  ) => ({
    transcript,
    durationMs,
    usage: u,
  })
  const one = budgetTurn([
    tool('bash', { command: 'ls' }),
    tool('bash', { command: 'pwd' }),
    edit('a.ts'),
  ])
  const two = budgetTurn([tool('bash', { command: 'make' })], 2000)

  test('a turn within each limit passes; over one names it with the figure', () => {
    assert.equal(
      withinLimits(one, { tokens: 1050, toolCalls: 3, duration: '1s' }, false).pass,
      true,
    )
    const over = withinLimits(one, { tokens: 1000, toolCalls: { bash: 1, read: 0 } }, false)
    assert.equal(over.pass, false)
    assert.equal(
      over.message(),
      'went over its budget: tokens 1,050 > 1,000 (subagents included) · bash 2 > 1',
    )
  })

  test('c sums every turn', () => {
    const c = { turns: [one, two] }
    assert.equal(withinLimits(c, { toolCalls: { bash: 3 }, tokens: 2100 }, false).pass, true)
    assert.equal(
      withinLimits(c, { toolCalls: { bash: 2 }, duration: '2s' }, false).message(),
      'went over its budget: bash 3 > 2 · duration 3s > 2s',
    )
  })

  test('a null usage refuses tokens only', () => {
    const none = budgetTurn([tool('bash', {})], 10, null)
    throws(() => withinLimits(none, { tokens: 5 }, false), /can't check tokens/)
    assert.equal(withinLimits(none, { toolCalls: 1 }, false).pass, true)
  })

  test('bad limits and .not are misuse TypeErrors', () => {
    const typeError = (limits: unknown, message: RegExp, not = false) =>
      assert.throws(
        () => withinLimits(one, limits, not),
        (e: Error) => {
          assert.equal(e.name, 'TypeError')
          assert.ok(isMisuse(e), 'a misuse, which the attempt records as its error')
          assert.match(e.message, message)
          return true
        },
      )
    typeError({}, /needs at least one limit/)
    typeError({ toolcalls: 3 }, /no limit "toolcalls".*Did you mean "toolCalls"\?/)
    typeError({ tokens: -1 }, /tokens is a whole number/)
    typeError({ toolCalls: { bash: 1.5 } }, /toolCalls\.bash is a whole number/)
    typeError({ duration: 'soon' }, /duration: Invalid duration/)
    typeError({ tokens: 5 }, /can't be negated/, true)
  })

  test('the label lists the limits', () => {
    assert.equal(
      limitsLabel({ tokens: 200_000, toolCalls: { bash: 10 }, duration: '5m' }),
      'tokens 200,000, bash 10, duration 5m',
    )
    assert.equal(limitsLabel({ toolCalls: 3 }), 'toolCalls 3')
    assert.equal(limitsLabel({ toolCalls: { bash: 10_000 } }), 'bash 10,000')
  })
})
