import assert from 'node:assert/strict'
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { test } from 'node:test'
import { pkgRoot, readRun, runCli, tempDir } from './helpers.ts'

const examples = join(pkgRoot, '../../examples')

/** A copy of `examples/<name>` outside the repo, with `reeval` linked to this package. */
async function copyOut(name: string): Promise<string> {
  const from = join(examples, name)
  const dir = tempDir(`${name}-copy`)
  // Another drive, on Windows, is outside too: relative() is then absolute.
  const fromRepo = relative(join(pkgRoot, '../..'), dir)
  assert.ok(fromRepo.startsWith('..') || isAbsolute(fromRepo), 'the copy is outside the repo')
  cpSync(from, dir, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|\.reeval)([/\\]|$)/.test(src.slice(from.length)),
  })
  await mkdir(join(dir, 'node_modules'))
  await symlink(pkgRoot, join(dir, 'node_modules/reeval'), 'dir')
  // examples/tsconfig.json is for the editor and `pnpm typecheck`; a copy runs without one.
  assert.equal(existsSync(join(dir, 'tsconfig.json')), false, `${name} has no tsconfig.json`)
  return dir
}

type Cell = { key: string; harness: string; sandbox: string }

/**
 * Each `with-*` example: the harness and sandbox every cell plans under each profile (no profile
 * is the fake trio), and each cell's attempts' outcomes once it has run on the fake harness.
 */
const WITH: Record<
  string,
  {
    profiles: Record<string, { harness: string; sandbox: string }>
    outcomes: Record<string, string[]>
  }
> = {
  'with-checks': {
    profiles: { cursor: { harness: 'cursor:composer-2.5', sandbox: 'docker' } },
    outcomes: { 'fake/math/fake': ['pass'] },
  },
  'with-skill-lift': {
    profiles: { cursor: { harness: 'cursor:composer-2.5', sandbox: 'docker' } },
    outcomes: {
      'fake/math/fake': ['fail', 'fail', 'fail', 'fail'],
      'fake/changelog/fake': ['pass', 'pass', 'pass', 'pass'],
    },
  },
}

test('every with-* example is in the table', () => {
  const dirs = readdirSync(examples).filter((d) => d.startsWith('with-'))
  assert.deepEqual(dirs.sort(), Object.keys(WITH).sort())
})

for (const [name, { profiles, outcomes }] of Object.entries(WITH)) {
  test(`examples/${name} copied out of the repo plans and runs key-free`, async () => {
    const dir = await copyOut(name)
    const planned = { '': { harness: 'fake', sandbox: 'fake' }, ...profiles }
    for (const [profile, want] of Object.entries(planned)) {
      const args = ['run', '--dry-run', '--json', ...(profile ? ['--profile', profile] : [])]
      const plan = await runCli(dir, args)
      assert.equal(plan.code, 0, `${args.join(' ')}\n${plan.stdout}${plan.stderr}`)
      const evals: { file: string; cells: Cell[] }[] = JSON.parse(plan.stdout).evals
      assert.deepEqual([...new Set(evals.map((e) => e.file))], [`${name}.eval.ts`])
      for (const cell of evals.flatMap((e) => e.cells)) {
        assert.deepEqual({ harness: cell.harness, sandbox: cell.sandbox }, want, args.join(' '))
      }
    }

    const run = await runCli(dir, ['run'], { timeoutMs: 180_000 })
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const ran: Record<string, string[]> = {}
    for (const a of readRun(dir).evals.flatMap((e) => e.attempts)) {
      ran[a.cell] = [...(ran[a.cell] ?? []), a.outcome].sort()
    }
    assert.deepEqual(ran, outcomes)
  })
}

test('test/real-agents plans the nightly smoke and questions profiles', async () => {
  const dir = join(pkgRoot, 'test/real-agents')
  const plans = {
    smoke: ['run', '--dry-run', '--json', '--profile', 'smoke'],
    questions: [
      'run',
      '--dry-run',
      '--json',
      '--config',
      'reeval.analysis.config.ts',
      '--profile',
      'questions',
    ],
  }
  const cells: Record<string, string[]> = {}
  for (const [profile, args] of Object.entries(plans)) {
    const plan = await runCli(dir, args)
    assert.equal(plan.code, 0, `${args.join(' ')}\n${plan.stdout}${plan.stderr}`)
    const evals: { file: string; cells: Cell[] }[] = JSON.parse(plan.stdout).evals
    cells[profile] = evals.flatMap((e) => e.cells.map((c) => `${e.file} ${c.harness}`)).sort()
  }
  assert.deepEqual(cells, {
    smoke: [
      'evals/brokering.eval.ts cursor:composer-2.5',
      'evals/gemini.eval.ts cursor:composer-2.5',
    ],
    questions: [
      'evals/questions.eval.ts cursor:composer-2.5',
      'evals/questions.eval.ts cursor:composer-2.5',
      'evals/questions.eval.ts pi:gemini-3.8-flash',
      'evals/questions.eval.ts pi:gemini-3.8-flash',
    ],
  })
})
