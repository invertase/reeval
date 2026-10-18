import { evaluate, expect, group } from 'reeval'
import { arms, GUIDES } from './envs.ts'
import { patchOf } from './repo.ts'
import { TASKS } from './tasks.ts'

// Can an agent contribute to reeval, and do AGENTS.md and the feature contract help? Each task is
// a merged change asked for again from its parent commit. The change's own tests are placed after
// the turn, so the agent never sees them; the repo's build, lint, typecheck and docs check run on
// what it left.

const FOOTER =
  "\n\nThe repository is checked out with its dependencies installed. Make the change as you would for a pull request to this repository. You don't need to commit."

// REEVAL_CONTRIBUTING_ORACLE=1 with the fake config applies the merged change instead of an agent:
// every check must pass on it, and fail on the fake agent's empty change.
const ORACLE = process.env.REEVAL_CONTRIBUTING_ORACLE === '1'

group('contributing to reeval', { timeout: '45m' }, () => {
  for (const task of TASKS) {
    const { control, variant } = arms(task)
    evaluate(
      `${task.title} (#${task.pr.number})`,
      { compare: { baseline: control, variants: [variant], gate: 'none' } },
      async (c) => {
        if (ORACLE && c.attempt.cell.harness.startsWith('fake')) {
          await c.writeFile('~/oracle.patch', patchOf(task.pr.parent, task.pr.sha, GUIDES))
          await expect(c.exec('git apply ~/oracle.patch')).toSucceed()
        }
        await c.send(task.prompt + FOOTER)

        expect.soft(c, 'adds or updates tests').toHaveChanged('packages/reeval/test/**')
        expect.soft(c, 'updates the docs').toHaveChanged('docs/**')
        for (const t of task.touches) expect.soft(c, t.label).toHaveChanged(t.paths)

        await expect.soft(c.exec('pnpm build'), 'pnpm build').toSucceed()
        await expect.soft(c.exec('pnpm lint'), 'pnpm lint').toSucceed()
        await expect.soft(c.exec('pnpm --filter reeval typecheck'), 'typecheck').toSucceed()
        await expect.soft(c.exec('pnpm docs:check'), 'pnpm docs:check').toSucceed()

        for (const [path, text] of Object.entries(task.hidden.files)) await c.writeFile(path, text)
        await expect.soft(c.exec(task.hidden.run), "the merged change's tests").toSucceed()
      },
    )
  }
})
