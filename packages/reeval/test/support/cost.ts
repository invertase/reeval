import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Two recorded runs of `evals/cost.eval.ts › greets` on Cursor in `evals/.history`: three counted
 * attempts with usage and one judge call each, plus an infra error that must not count.
 */
export function writePastCostRuns(root: string): void {
  const dir = join(root, 'evals', '.history')
  mkdirSync(dir, { recursive: true })
  const cell = 'cursor:composer-2.5/-/docker'
  const attempt = (n: number, cacheRead: number, outcome = 'pass') => ({
    key: `evals/cost.eval.ts › greets # ${cell}#${n}`,
    cell,
    outcome,
    usage: { input: 40_000, cacheRead, cacheWrite: 0, output: 8_000, reasoning: null },
    judgements: outcome === 'pass' ? [{ model: 'google/gemini-3.8-flash' }] : [],
  })
  const runs = [
    ['20261001T000000Z_aaaaaaa_test', [attempt(1, 600_000), attempt(2, 900_000)]],
    [
      '20261002T000000Z_bbbbbbb_test',
      [attempt(1, 1_200_000), attempt(2, 9_000_000, 'infra_error')],
    ],
  ] as const
  for (const [runId, attempts] of runs) {
    const record = {
      kind: 'reeval-run',
      schemaVersion: 1,
      runId,
      status: 'complete',
      evals: [
        {
          id: 'evals/cost.eval.ts › greets',
          cells: [{ key: cell, harness: 'cursor:composer-2.5' }],
          attempts,
        },
      ],
    }
    writeFileSync(join(dir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  }
}
