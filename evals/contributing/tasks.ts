import { showAll } from './repo.ts'

/** A change from reeval's history, asked for again from the commit before it landed. */
export type Task = {
  /** Environment names start with it. */
  id: string
  title: string
  /** The merged commit, and its parent, where the agent starts. */
  pr: { number: number; sha: string; parent: string }
  prompt: string
  /** Paths the change should touch, by what the contributor guides ask for. */
  touches: Array<{ label: string; paths: string | string[] }>
  /** Files from the merged commit, placed after the agent's turn, and the command that runs them. */
  hidden: { files: Record<string, string>; run: string }
}

const test = (file: string, pattern: string, env = '') =>
  `(cd packages/reeval && ${env}node --test --experimental-strip-types --no-warnings --test-name-pattern=${JSON.stringify(pattern)} ${file})`

const task = (t: Omit<Task, 'hidden'> & { hidden: { files: string[]; run: string[] } }): Task => ({
  ...t,
  hidden: { files: showAll(t.pr.sha, t.hidden.files), run: t.hidden.run.join(' && ') },
})

export const TASKS: Task[] = [
  task({
    id: 'analyze-vs-none',
    title: 'reeval analyze --vs none',
    pr: {
      number: 287,
      sha: '4830182eace0a938964ccd84439b3fc464333945',
      parent: '8351babbee2d5cbec0cdea72ffd844273766775d',
    },
    prompt: `\`reeval analyze\` always compares a run with its nearest recorded ancestor, or with the run \`--vs <run>\` names. Add \`reeval analyze --vs none\` to write up one run on its own. With it there is no base run: the digest's \`scope.base\` is null, and the digest has no facts that compare two runs (no \`eval-changed\`, \`drift\` or \`compare\` facts, and no \`pooled\` or \`observed\` factor rows). It works with \`--context\` and \`--dry-run\`, whose first line then names only the run, with no " vs ". \`--vs latest\` naming the run itself still exits 2 with "reeval analyze --vs names the run itself".`,
    touches: [
      { label: 'documents --vs none in the CLI help', paths: 'packages/reeval/src/cli-spec.ts' },
    ],
    hidden: {
      files: ['packages/reeval/test/analysis.test.ts'],
      run: [test('test/analysis.test.ts', '--vs none analyses this run only')],
    },
  }),
  task({
    id: 'query-reasoning-effort',
    title: 'reasoning effort columns in reeval query',
    pr: {
      number: 316,
      sha: '0f2aa59778b6bcb10739bed90ab961256832fe06',
      parent: 'e16095b1bc9926fb130024b527e8bc1f2d98eb1a',
    },
    prompt: `\`reeval query\` has no column for the reasoning effort a harness factory asked for (the \`effort\` option on \`cursor()\`, \`claudeCode()\` and the others) or for the effort the harness says it served. The harness label also calls it plain "effort", which reads like reeval's effort metric (tool calls, agent time, tokens). Add a \`reasoning_effort\` column to the \`cells\` table, and \`reasoning_effort\` and \`served_reasoning_effort\` columns to the \`attempts\` table, each null when unset; the \`effort\` view stays the measured metric and gets no such column. Rename it in the harness label too: \`harnessLabel\` in \`packages/reeval/src/view/model.ts\` should give \`fake (reasoning effort high, served fake-1[effort=medium], served reasoning effort medium)\` for a fake harness with \`effort: 'high'\` that served \`fake-1[effort=medium]\`.`,
    touches: [],
    hidden: {
      files: ['packages/reeval/test/query.test.ts'],
      run: [test('test/query.test.ts', 'reasoning effort, requested and served')],
    },
  }),
  task({
    id: 'to-have-changed',
    title: 'a toHaveChanged matcher',
    pr: {
      number: 314,
      sha: '206276c60f95b16a40f4feeeadeb80fed0a8f12a',
      parent: '1473ae3381395296e6c997ec741b623ee9d0a356',
    },
    prompt: `Add a \`toHaveChanged(paths?)\` matcher. \`expect(turn).toHaveChanged(paths?)\`, or \`expect(c)\` for the latest turn (nothing before a turn), passes when the workspace diff has a file matching any of \`paths\`: a glob against the path from the workspace root (\`greet.ts\` doesn't match \`src/greet.ts\`), which also matches everything under a directory it names (so \`test\` and \`./test/\` mean \`test/**\`), a RegExp, or a list of them. With no argument any change passes. Unlike \`toHaveEdited\`, which reads the transcript, it sees writes made by shell commands and subprocesses. Its messages name the files. For a diff that modified \`test/greet.test.js\` and added \`src/greet.ts\`, a miss lists every changed file, \`expected changes to package.json, got ["test/greet.test.js" (modified), "src/greet.ts" (added)]\`, and a negated hit lists only the files that matched, \`expected no changes to test/**, got ["test/greet.test.js" (modified)]\`; with an empty diff it's \`expected changes, got none\`. Anything other than a turn or \`c\` throws \`toHaveChanged() expects a turn from c.send(), or c\`. Build it like the other transcript matchers, on a \`changed(actual, paths?)\` helper exported from \`packages/reeval/src/assert.ts\`.`,
    touches: [
      {
        label: 'adds a feature fixture with a canary',
        paths: 'packages/reeval/test/features/**/canary.eval.ts',
      },
      {
        label: 'lists it in the feature inventory',
        paths: 'packages/reeval/test/features/inventory.ts',
      },
    ],
    hidden: {
      files: [
        'packages/reeval/test/assert.test.ts',
        'packages/reeval/test/features.test.ts',
        'packages/reeval/test/features/assert/changed/reeval.config.ts',
        'packages/reeval/test/features/assert/changed/evals/env.ts',
        'packages/reeval/test/features/assert/changed/evals/lands.eval.ts',
        'packages/reeval/test/features/assert/changed/evals/canary.eval.ts',
      ],
      run: [
        test(
          'test/assert.test.ts',
          'matches the diff with globs|reads c as of its latest turn|names the files it saw',
        ),
        test('test/features.test.ts', 'assert/changed \\[fake\\]', 'REEVAL_FIXTURE_TIERS=fake '),
      ],
    },
  }),
  task({
    id: 'question-model',
    title: 'question.model as a cascading default',
    pr: {
      number: 366,
      sha: '1ca53dd9afa771bf4fb04b6f1b58f37f42a1cd70',
      parent: 'd875b9298ee8ff18a4ba785c8a6878d5bacfe23c',
    },
    prompt: `Compare questions take a model per entry (\`{ question, model }\`), but the \`question\` option, the defaults for every compare question that cascade from the config through groups to evals, refuses \`model\`. Let \`question: { model: 'provider/model' }\` set the model for every compare question below it that doesn't name its own: an entry's \`model\` wins over the cascaded one, which wins over \`analysis.model\`. Refuse a model there without a provider prefix, or an evaluation model such as \`typesafe-ai/jev-1.13.0\`, as entries already do. \`reeval run --dry-run\` (and \`--json\`) shows each question's resolved model.`,
    touches: [
      { label: 'adds refusal rows', paths: 'packages/reeval/test/refusals/**' },
      { label: 'adds a plan case', paths: 'packages/reeval/test/plan/**' },
    ],
    hidden: {
      files: [
        'packages/reeval/test/options.test.ts',
        'packages/reeval/test/plan.test.ts',
        'packages/reeval/test/plan/compare/evals/questions-model.eval.ts',
        'packages/reeval/test/plan/compare/expected/questions-model.txt',
      ],
      run: [
        test('test/options.test.ts', 'question.model cascades to every question'),
        test('test/plan.test.ts', 'compare: questions-model'),
      ],
    },
  }),
]
