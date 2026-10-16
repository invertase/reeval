import assert from 'node:assert/strict'
import { cpSync, readFileSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { test } from 'node:test'
import { pkgRoot, readRun, runCli, tempDir } from './helpers.ts'

const example = join(pkgRoot, '../../examples/hello')

test('examples/hello copied out of the repo runs on the fake harness', async () => {
  const dir = tempDir('hello-copy')
  // Another drive, on Windows, is outside too: relative() is then absolute.
  const fromRepo = relative(join(pkgRoot, '../..'), dir)
  assert.ok(fromRepo.startsWith('..') || isAbsolute(fromRepo), 'the copy is outside the repo')
  cpSync(example, dir, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|\.reeval)([/\\]|$)/.test(src.slice(example.length)),
  })
  await mkdir(join(dir, 'node_modules'))
  await symlink(pkgRoot, join(dir, 'node_modules/reeval'), 'dir')

  const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'))
  assert.equal(tsconfig.extends, undefined, 'tsconfig.json extends nothing outside the example')

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
