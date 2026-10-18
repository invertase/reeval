import type { AttemptContext } from 'reeval'

type Plan = {
  totals: { evals: number; cells: number; attempts: number }
  evals: {
    cells: { role: string; environment: string; runs: number }[]
    questions?: { question: string; shows: string[] }[]
  }[]
}

/** `reeval run --dry-run --json` in the agent's project, parsed; `plan` is null when it fails. */
export async function dryRun(c: AttemptContext) {
  const r = await c.exec('./node_modules/.bin/reeval run --dry-run --json')
  let plan: Plan | null = null
  try {
    plan = r.exitCode === 0 ? (JSON.parse(r.stdout) as Plan) : null
  } catch {}
  return { exitCode: r.exitCode, plan }
}

export const typechecks = './node_modules/.bin/tsc -p .'
export const runsOnFake = './node_modules/.bin/reeval run --ui plain'
