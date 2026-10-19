import { evaluate, expect, group } from 'reeval'
import { channels, PREAMBLE, project } from './_support/skill/channels.ts'
import { dryRun, typechecks } from './_support/skill/checks.ts'

const task =
  PREAMBLE +
  'evals/landing.eval.ts builds a landing page and screenshots it as `home`. Turn it into a ' +
  'skill comparison: the control has no skill, the variant gets the design skill in ' +
  'skills/design, 2 runs per cell. Add a compare question asking which landing page follows ' +
  "the design guidelines more closely, and let the question see each side's `home` " +
  'screenshot. Keep the existing checks. `npx reeval run --dry-run` must plan it and it must ' +
  "typecheck with `npx tsc -p .`; you don't need to run it."

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
