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

/**
 * Each `with-*` example: the profiles its plan is checked under, besides none, and the arguments
 * that run it on the fake harness (`null` when it can't run key-free).
 */
const WITH: Record<string, { profiles: string[]; run: string[] | null }> = {
  'with-checks': { profiles: ['cursor'], run: [] },
  'with-skill-lift': { profiles: ['cursor'], run: [] },
}

test('every with-* example is in the table', () => {
  const dirs = readdirSync(examples).filter((d) => d.startsWith('with-'))
  assert.deepEqual(dirs.sort(), Object.keys(WITH).sort())
})

for (const [name, { profiles, run }] of Object.entries(WITH)) {
  test(`examples/${name} copied out of the repo plans${run ? ' and runs key-free' : ''}`, async () => {
    const dir = await copyOut(name)
    for (const profile of [undefined, ...profiles]) {
      const args = ['run', '--dry-run', '--json', ...(profile ? ['--profile', profile] : [])]
      const plan = await runCli(dir, args)
      assert.equal(plan.code, 0, `${args.join(' ')}\n${plan.stdout}${plan.stderr}`)
      const files = JSON.parse(plan.stdout).evals.map((e: { file: string }) => e.file)
      assert.deepEqual([...new Set(files)], [`${name}.eval.ts`])
    }
    if (!run) return

    const result = await runCli(dir, ['run', ...run], { timeoutMs: 180_000 })
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const { evals } = readRun(dir)
    assert.ok(evals.length > 0, 'ran an eval')
    assert.ok(
      evals.every((e) => e.outcome === 'pass'),
      evals.map((e) => `${e.id}: ${e.outcome}`).join('\n'),
    )
  })
}

test('examples/hello copied out of the repo runs on the fake harness', async () => {
  const dir = await copyOut('hello')

  const plan = await runCli(dir, [
    'run',
    '--config',
    'reeval.fake.config.ts',
    '--dry-run',
    '--json',
  ])
  assert.equal(plan.code, 0, plan.stdout + plan.stderr)
  const files = new Set(JSON.parse(plan.stdout).evals.map((e: { file: string }) => e.file))
  assert.deepEqual([...files].sort(), [
    'evals/greetings.eval.ts',
    'evals/hello.eval.ts',
    'evals/preferences.eval.ts',
    'evals/skill.eval.ts',
  ])

  const run = await runCli(dir, ['run', '--config', 'reeval.fake.config.ts'], {
    timeoutMs: 180_000,
  })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  const { evals } = readRun(dir)
  assert.ok(evals.length >= 3, `ran ${evals.length} evals`)
  assert.ok(
    evals.every((e) => e.outcome === 'pass'),
    evals.map((e) => `${e.id}: ${e.outcome}`).join('\n'),
  )
})
