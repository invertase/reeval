import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'
import { changedOnto, show } from './repo.ts'
import type { Task } from './tasks.ts'

/** What the arms differ by: the repo's guide for contributors, and the feature contract. */
export const GUIDES = ['AGENTS.md', 'packages/reeval/test/features/README.md']

/** Node, pnpm and every task's dependencies already in the pnpm store, so an install is offline. */
const sandbox = docker({
  dockerfile: './sandbox/Dockerfile',
  memory: '4g',
  cpus: 2,
  maxConcurrent: 1,
  id: 'reeval-repo',
})

const install = { run: 'pnpm install --frozen-lockfile --prefer-offline', timeout: '10m' }

/** The repo at the commit before the task's change landed, installed but not built. */
const repoAt = (
  task: Task,
  name: string,
  more: { files?: Record<string, string>; setup?: string[] },
) =>
  defineEnvironment(name, ({ git }) => ({
    sandbox,
    workspace: git('../..', { ref: task.pr.parent, init: true }),
    files: more.files ?? {},
    setup: [...(more.setup ?? []), install],
  }))

const amend =
  'git add -A && git -c user.name=reeval -c user.email=reeval@localhost commit -q --amend --no-edit'

/**
 * A branch of guide changes to try as a third arm, as `REEVAL_CONTRIBUTING_GUIDES=<branch>`: the
 * branch's diff from HEAD's history, applied to each task's starting commit.
 */
const NEW_GUIDES = process.env.REEVAL_CONTRIBUTING_GUIDES

/**
 * The arms of one task. The control has no guides, and its one commit doesn't either, so
 * `git status` and `git show` don't point at them. The variant places them as files, so
 * `reeval query skill_files` counts the agent's reads of each. `newGuides`, with
 * REEVAL_CONTRIBUTING_GUIDES set, has that branch's guides, committed like the control.
 */
export function arms(task: Task) {
  return {
    newGuides: NEW_GUIDES
      ? repoAt(task, `${task.id}-new-guides`, {
          files: changedOnto(task.pr.parent, NEW_GUIDES),
          setup: [amend],
        })
      : undefined,
    control: repoAt(task, `${task.id}-no-guides`, {
      setup: [`rm -f ${GUIDES.join(' ')} && ${amend}`],
    }),
    variant: repoAt(task, `${task.id}-guides`, {
      files: Object.fromEntries(GUIDES.map((p) => [p, show(task.pr.parent, p)])),
    }),
  }
}
