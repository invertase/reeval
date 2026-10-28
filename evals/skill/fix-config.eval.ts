import { evaluate, expect, group } from 'reeval'
import { channels, PREAMBLE, project } from './channels.ts'
import { dryRun, runsOnFake } from './checks.ts'

const task =
  PREAMBLE +
  '`npx reeval run --dry-run` fails. Fix reeval.config.ts and the evals so the plan is what ' +
  'the author meant: the docs eval compares no docs (the control) against the with-docs ' +
  'environment, 3 runs per cell, and `npx reeval run` passes. Leave docs/ alone. Then list ' +
  'each mistake you fixed, one line each.'

group(
  'fix a broken config',
  { compare: { ...channels(project('notes', 'fix-config')), gate: 'none' } },
  () => {
    evaluate('fixes the config and the eval', async (c) => {
      const turn = await c.send(task)
      const { exitCode, plan } = await dryRun(c)
      expect(exitCode, 'reeval run --dry-run exits 0').toBe(0)
      expect(plan?.totals, 'plans 2 cells and 6 attempts').toMatchObject({
        evals: 1,
        cells: 2,
        attempts: 6,
      })
      const variant = plan?.evals[0]?.cells.find((cell) => cell.role === 'variant')
      expect(variant?.environment, 'with-docs is the variant').toBe('with-docs')
      await expect(c.exec(runsOnFake), 'passes on the fake config').toSucceed()
      expect(c, 'leaves docs/ alone').not.toHaveChanged(['docs/**'])
      expect(turn.text, 'names the missing await').toMatch(/await/i)
    })
  },
)
