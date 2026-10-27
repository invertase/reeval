// Checks that hold docs/evaluations/runs/ to the code it describes. docs.mjs --check calls it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RUN_FLAGS = ['--ui', '--log-order', '--log-prefix', '--output-logs']

/** The values each output flag accepts, from the `pick(...)` calls in ui/mode.ts. */
export function outputFlagValues(source) {
  const values = new Map()
  const pick = /pick\(\s*'(--[\w-]+)'[\s\S]*?\[([^\]]*)\]\s*as const/g
  for (const [, flag, list] of source.matchAll(pick)) {
    values.set(flag, ['auto', ...[...list.matchAll(/'([^']+)'/g)].map((m) => m[1])])
  }
  return values
}

/** A table row `| \`--flag\` | \`a\`, \`b\` | … |` in running.mdx: the values it lists. */
function listedValues(page, flag) {
  const row = page.split('\n').find((line) => line.startsWith(`| \`${flag}\` |`))
  if (!row) return undefined
  return [...(row.split('|')[2] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

/** The CI job steps in a workflow snippet that run `reeval run`, with the step's whole text. */
export function runSteps(page) {
  const steps = []
  for (const [, yaml] of page.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)) {
    for (const step of yaml.split(/\n(?=\s*- )/)) {
      if (/npx reeval run\b/.test(step)) steps.push(step)
    }
  }
  return steps
}

/** Exit 1 is a failing evaluation, which `reeval compare --fail-on-regression` decides. */
export function leavesExitOneToCompare(step) {
  return /set \+e/.test(step) && /code=\$\?/.test(step) && /\$code"? -gt 1/.test(step)
}

export function docsRunsProblems(root) {
  const problems = []
  const docs = join(root, 'docs/evaluations/runs')

  const accepted = outputFlagValues(
    readFileSync(join(root, 'packages/reeval/src/ui/mode.ts'), 'utf8'),
  )
  const running = readFileSync(join(docs, 'running.mdx'), 'utf8')
  for (const flag of RUN_FLAGS) {
    const want = accepted.get(flag)
    if (!want) {
      problems.push(`ui/mode.ts has no pick() for ${flag}: update scripts/docs-runs-checks.mjs`)
      continue
    }
    const have = listedValues(running, flag)
    if (!have) continue
    const missing = want.filter((value) => !have.includes(value))
    if (missing.length) {
      problems.push(
        `docs/evaluations/runs/running.mdx lists ${flag} values without ${missing.map((v) => `\`${v}\``).join(', ')}, which ui/mode.ts accepts`,
      )
    }
  }

  const ci = readFileSync(join(docs, 'ci.mdx'), 'utf8')
  for (const step of runSteps(ci)) {
    if (!leavesExitOneToCompare(step)) {
      problems.push(
        'docs/evaluations/runs/ci.mdx runs `npx reeval run` so exit 1 fails the job before `reeval compare --fail-on-regression` decides: wrap it with `set +e`, `code=$?` and `[ "$code" -gt 1 ]` as examples/with-github-pr-gate/workflow.yml does',
      )
    }
  }
  return problems
}
