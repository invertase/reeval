import { evaluate, expect, group } from 'reeval'
import { channels, PREAMBLE, project } from './utils/channels.ts'
import { dryRun, typechecks } from './utils/checks.ts'

const task =
  PREAMBLE +
  'evals/landing.eval.ts builds a landing page and screenshots it as `home`. A design skill lives in ' +
  'skills/design. Set up the project so reeval can measure whether that skill improves landing pages: ' +
  'use reeval compare with two runs per side, keep the existing checks, and add a compare question ' +
  '(screenshots visible to the judge) about which run follows the design guidelines more closely. ' +
  '`npx reeval run --dry-run` must plan the comparison and `npx tsc -p .` must pass; you do not need ' +
  'to run the full eval.'

group(
  'add a compare with a question',
  { compare: { ...channels(project('landing', 'compare')), gate: 'none' } },
  () => {
    evaluate('adds a compare with a screenshot question', async (c) => {
      await c.send(task)
      await expect.soft(c.exec(typechecks), 'typechecks').toSucceed()
      const { plan } = await dryRun(c)
      expect
        .soft(plan?.totals, 'plans 2 cells and 4 attempts')
        .toMatchObject({ evals: 1, cells: 2, attempts: 4 })
      const roles = plan?.evals[0]?.cells.map((cell) => cell.role).sort()
      expect.soft(roles, 'a control and a variant').toEqual(['control', 'variant'])
      const question = plan?.evals[0]?.questions?.[0]
      expect.soft(question?.question ?? '', 'asks a compare question').toMatch(/design/i)
      const source = (await c.readFile('evals/landing.eval.ts')) ?? ''
      expect.soft(question?.shows ?? [], 'the question sees screenshots').toContain('artifacts')
      expect.soft(source, 'the home screenshot').toMatch(/artifacts:\s*(\[\s*['"`]home['"`]|true)/)
      expect.soft(source, 'keeps the capture').toMatch(/capture\(/)
      expect.soft(source, 'uses the design skill').toMatch(/skills\/design/)
    })
  },
)
