// Full dogfood eval oracle runs (fake harness): the monorepo's mcp-debugging eval file, synced into
// a temp project. Key-free; complements the minimal feature fixtures under test/features/dogfood/.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pkgRoot, runCli, tempDir } from './helpers.ts'

const repoRoot = join(pkgRoot, '../..')
const oracleScript = join(repoRoot, 'evals/_support/mcp-debugging/scripts/oracle.mjs')

const oracleExec = `node ${JSON.stringify(oracleScript)}`
const oracleConfig = `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

const oracle = ${JSON.stringify(oracleExec)}

export default defineConfig({
  include: ['evals/mcp-debugging.eval.ts'],
  harness: fakeHarness({ script: [[{ exec: oracle }]], text: 'Fixed it.' }),
  sandbox: fakeSandbox(),
  profiles: {
    canary: {
      defaults: { harness: fakeHarness({ script: [[{ exec: \`\${oracle} --cheat\` }]] }) },
    },
  },
})
`

function syncDogfoodMcp(dir: string) {
  mkdirSync(join(dir, 'evals'), { recursive: true })
  cpSync(join(repoRoot, 'evals/mcp-debugging.eval.ts'), join(dir, 'evals/mcp-debugging.eval.ts'))
  cpSync(
    join(repoRoot, 'evals/_support/mcp-debugging'),
    join(dir, 'evals/_support/mcp-debugging'),
    {
      recursive: true,
    },
  )
  cpSync(
    join(repoRoot, 'evals/_fixtures/mcp-debugging'),
    join(dir, 'evals/_fixtures/mcp-debugging'),
    {
      recursive: true,
    },
  )
  writeFileSync(join(dir, 'reeval.config.ts'), oracleConfig)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  execFileSync('ln', ['-sf', pkgRoot, join(dir, 'node_modules/reeval')], { stdio: 'ignore' })
}

test('dogfood mcp-debugging eval: oracle passes every task', async () => {
  const dir = tempDir('dogfood-mcp-oracle')
  syncDogfoodMcp(dir)
  const run = await runCli(dir, ['run', '--ui', 'plain'], { timeoutMs: 600_000 })
  assert.equal(run.code, 0, run.stdout + run.stderr)
})
