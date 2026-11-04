// `shellCommands` and the command-line reading behind `toHaveRun({ program })`: the separators,
// the quotes, and each wrapper on the fixed unwrap list.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseCommandLine, shellCommands } from '../src/shell-commands.ts'
import type { TranscriptEvent } from '../src/types.ts'

const at = { ts: '2026-10-05T12:00:00.000Z', atMs: 0, durationMs: 1 }

const call = (command: string, tool = 'bash', ok: boolean | null = true): TranscriptEvent => ({
  ...at,
  type: 'tool',
  toolCallId: `call_${command}`,
  tool,
  input: { command },
  output: '',
  ok,
})

const programs = (line: string) =>
  parseCommandLine(line).map((c) => [c.program, ...c.args].join(' '))

describe('parseCommandLine', () => {
  const cases: [line: string, expected: string[]][] = [
    ['genkit flow:run x', ['genkit flow:run x']],
    [
      'cd app && genkit start || echo failed; ls | wc -l',
      ['cd app', 'genkit start', 'echo failed', 'ls', 'wc -l'],
    ],
    ['npm run dev & genkit start', ['npm run dev', 'genkit start']],
    ['genkit start 2>&1 | tee log', ['genkit start 2>&1', 'tee log']],
    ['genkit start &> log', ['genkit start &> log']],
    ['make |& tee log', ['make', 'tee log']],
    ['echo one\necho two', ['echo one', 'echo two']],
    ['genkit \\\n  start', ['genkit start']],
    ['# set up\ngenkit start # run it', ['genkit start']],
    ['echo "a && b" \'c; d\' e\\ f', ['echo a && b c; d e f']],
    ['echo "say \\"hi\\""', ['echo say "hi"']],
    ['echo a#b', ['echo a#b']],
    ["echo ''", ['echo ']],
    ['FOO=1 BAR="x y" genkit start', ['genkit start']],
    ['env -u HOME FOO=1 genkit start', ['genkit start']],
    ['timeout 30 genkit start', ['genkit start']],
    ['timeout -s KILL 5m genkit start', ['genkit start']],
    ['time -p genkit start', ['genkit start']],
    ['exec genkit start', ['genkit start']],
    ['sudo -u app genkit start', ['genkit start']],
    ['sudo FOO=1 genkit start', ['genkit start']],
    ['/usr/bin/timeout 5 ./node_modules/.bin/genkit start', ['genkit start']],
    ['npx genkit flow:run x', ['genkit flow:run x']],
    ['npx -y genkit@latest flow:run x', ['genkit flow:run x']],
    ['npx --package @genkit-ai/cli genkit start', ['genkit start']],
    ['npx @angular/cli@19 new app', ['@angular/cli new app']],
    ['npx -- skills add x', ['skills add x']],
    ['bunx skills add x', ['skills add x']],
    ['npm exec -- genkit start', ['genkit start']],
    ['npm x -y genkit start', ['genkit start']],
    ['npm -w web exec genkit start', ['genkit start']],
    ['pnpm exec genkit start', ['genkit start']],
    ['pnpm --filter web exec genkit start', ['genkit start']],
    ['pnpm dlx skills@1.2.0 add x', ['skills add x']],
    ['yarn dlx skills add x', ['skills add x']],
    ['FOO=1 timeout 10 sudo npx genkit start', ['genkit start']],
    ['npm install genkit', ['npm install genkit']],
    ['pnpm genkit start', ['pnpm genkit start']],
    ['yarn add genkit', ['yarn add genkit']],
    ['cat genkit.config.ts', ['cat genkit.config.ts']],
    ['npx --version', ['npx --version']],
    ['timeout 5', ['timeout 5']],
    ['FOO=1', []],
    ['  ;; && ', []],
    ['', []],
  ]
  for (const [line, expected] of cases) {
    test(JSON.stringify(line), () => assert.deepEqual(programs(line), expected))
  }

  test("the program's own @ is kept outside a package runner", () => {
    assert.deepEqual(parseCommandLine('./tool@2 run'), [{ program: 'tool@2', args: ['run'] }])
  })
})

describe('shellCommands', () => {
  const turns = [
    { transcript: [call('npx genkit flow:run x && ls'), call('notes.txt', 'read')] },
    { transcript: [call('pnpm dlx skills add y', 'shell', false), call('echo hi', 'bash', null)] },
  ]

  test('reads every turn of c, or a list of turns, with its index, line and ok', () => {
    const expected = [
      {
        program: 'genkit',
        args: ['flow:run', 'x'],
        line: 'npx genkit flow:run x && ls',
        ok: true,
        turn: 0,
      },
      { program: 'ls', args: [], line: 'npx genkit flow:run x && ls', ok: true, turn: 0 },
      { program: 'skills', args: ['add', 'y'], line: 'pnpm dlx skills add y', ok: false, turn: 1 },
      { program: 'echo', args: ['hi'], line: 'echo hi', ok: null, turn: 1 },
    ]
    assert.deepEqual(shellCommands({ turns }), expected)
    assert.deepEqual(shellCommands(turns), expected)
  })

  test('reads one turn as turn 0', () => {
    assert.deepEqual(
      shellCommands(turns[1] as (typeof turns)[number]).map((c) => [c.program, c.turn]),
      [
        ['skills', 0],
        ['echo', 0],
      ],
    )
  })

  test('refuses anything else', () => {
    assert.throws(
      () => shellCommands('npx genkit' as never),
      /shellCommands\(\) expects a turn from c\.send\(\), c\.turns, or c/,
    )
  })
})
