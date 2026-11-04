// `shellCommands` and the command-line reading behind `toHaveRun({ program })`: what we take from
// shell-quote's tokens, and each wrapper on the fixed unwrap list.
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
      'cd app && genkit start || echo failed; ls | wc -l &',
      ['cd app', 'genkit start', 'echo failed', 'ls', 'wc -l'],
    ],
    ['echo "a && b" \'c; d\' $HOME *.ts', ['echo a && b c; d $HOME *.ts']],
    ['genkit start > log 2>&1 # run it', ['genkit start']],
    ['echo 2 > f; head -n 2 >out', ['echo 2', 'head -n 2']],
    ['curl http://localhost/#top && genkit start', ['curl http://localhost/#top', 'genkit start']],
    ['echo \'a#b\' "c#d"', ['echo a#b c#d']],
    ['npm i\n# then start it\nnpx genkit start # now', ['npm i', 'genkit start']],
    ['npm test \\\n  --watch=false', ['npm test --watch=false']],
    ["/bin/bash -lc 'set -e\ngenkit start'", ['set -e', 'genkit start']],
    ['node -e "a()\nb()"', ['node -e a()\nb()']],
    [
      'cat > run.sh <<EOF\ncd app && genkit start\nEOF\nchmod +x run.sh',
      ['cat', 'chmod +x run.sh'],
    ],
    ["cat <<-'EOF'\n\tdon't genkit\n\tEOF\nls", ['cat', 'ls']],
    ['git commit -m "$(cat <<\'EOF\'\nfix; genkit\nEOF\n)"', ["git commit -m $(cat <<'EOF'\n)"]],
    ['echo $((1<<2))\ngenkit start', ['echo $', 'genkit start']],
    [
      'if [ -f x ]; then genkit start; else ! genkit init; fi',
      ['[ -f x ]', 'genkit start', 'genkit init'],
    ],
    ['for f in a b; do genkit run $f; done', ['genkit run $f']],
    ['{ genkit start; }', ['genkit start']],
    ['nohup nice -n 5 command genkit start &', ['genkit start']],
    ['command -v genkit', ['command -v genkit']],
    ["bash -e -o pipefail -c 'genkit start'", ['genkit start']],
    ['echo $(genkit version)', ['echo $', 'genkit version']],
    ['(cd app && genkit start)', ['cd app', 'genkit start']],
    ["/bin/bash -lc 'cd app && npx genkit start'", ['cd app', 'genkit start']],
    ['bash script.sh', ['bash script.sh']],
    ['FOO=1 BAR="x y" genkit start', ['genkit start']],
    ['env -u HOME FOO=1 genkit start', ['genkit start']],
    ['timeout 30 genkit start', ['genkit start']],
    ['time -p genkit start', ['genkit start']],
    ['exec genkit start', ['genkit start']],
    ['sudo -u app genkit start', ['genkit start']],
    ['/usr/bin/timeout 5 ./node_modules/.bin/genkit start', ['genkit start']],
    ['npx -y genkit@latest flow:run x', ['genkit flow:run x']],
    ['npx --package @genkit-ai/cli genkit start', ['genkit start']],
    ['npx @angular/cli@19 new app', ['@angular/cli new app']],
    ['bunx skills add x', ['skills add x']],
    ['npm exec -- genkit start', ['genkit start']],
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
