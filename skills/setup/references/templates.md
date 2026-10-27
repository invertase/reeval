# Setup templates

Copy the one that fits, then change the task, the checks and the names. Each is a whole eval:
`evals/environments.ts` plus one `evals/*.eval.ts`. Rerun `npx reeval run --dry-run` after every
edit.

## A. A skill, with and without

Say the project has `skills/acme-billing/SKILL.md`, with two rules among others: "money is an
integer number of cents, in a column whose name ends in `_cents`" and "every money column has a
`currency char(3)` beside it". A capable agent without the skill writes `numeric(10,2)` and no
currency, so the rules tell the arms apart. The task asks for the table, not the rules.

```ts
// evals/environments.ts
import { defineEnvironment } from 'reeval'

/** An empty workspace: the agent writes the SQL from scratch. */
export const plain = defineEnvironment('plain', {
  files: { '.gitignore': 'node_modules/\n' },
})

/** The same, with this repo's billing skill. */
export const withSkill = plain.extendEnvironment('with-billing-skill', ({ skill }) => ({
  skills: [skill.local('../skills/acme-billing')],
}))
```

```ts
// evals/invoice-amounts.eval.ts
import { evaluate, expect } from 'reeval'
import { plain, withSkill } from './environments.ts'

const migration = 'migrations/001_invoices.sql'

evaluate(
  'stores invoice totals in cents with the billing skill',
  { compare: { baseline: plain, variants: [withSkill] } },
  async (c) => {
    await c.send(
      `Write ${migration}: a Postgres migration creating an invoices table ` +
        'with a customer id, an issue date and the invoice total.',
    )
    const sql = ((await c.readFile(migration)) ?? '').toLowerCase()
    expect.soft(sql, 'creates invoices').toMatch(/create table[^;]*invoices/)
    expect.soft(sql, 'total in integer cents').toMatch(/\btotal\w*_cents\s+(big)?int/)
    expect.soft(sql, 'a currency column').toMatch(/\bcurrency\w*\s+(char|varchar)\s*\(\s*3/)
  },
)
```

Read the skill you're evaluating and choose its own most specific rules that a file or a command
can check; the example's rules are only a shape. A rule every agent already follows shows no
lift (both arms `2 of 2`), which is a real answer but a dull first run.

The canary and the oracle: profiles in `reeval.config.ts` whose fake agent writes a wrong and a
right answer. Write the oracle's answer differently from the one you had in mind (other column
names, another order, `bigint` for `integer`, `public.` before the table), so it catches a check
that wants one spelling.
Add `fakeHarness` to the harness import.

```ts
import { cursor, fakeHarness } from 'reeval/harness'
// … inside defineConfig({ … profiles: { …
    // A fake agent that stores the total as numeric: every eval must fail.
    canary: {
      defaults: {
        harness: fakeHarness({
          files: {
            'migrations/001_invoices.sql':
              'create table invoices (id int, total numeric(10,2));\n',
          },
          text: 'Done.',
        }),
      },
    },
    // A fake agent with a right answer: every eval must pass.
    oracle: {
      defaults: {
        harness: fakeHarness({
          files: {
            'migrations/001_invoices.sql':
              'CREATE TABLE public.invoices (\n  id bigserial PRIMARY KEY,\n' +
              '  currency_code varchar(3) NOT NULL,\n  total_amount_cents bigint NOT NULL\n);\n',
          },
          text: 'Done.',
        }),
      },
    },
```

`npx reeval run --profile canary invoice` and `--profile oracle` run them in the
real Docker sandbox with no keys (after `npx reeval image build`): the canary must exit 1 and
the oracle 0. Name the eval (`invoice` matches its name): the fake agent writes these files for
every eval, so with a second eval, give it its own `canary-<name>` and `oracle-<name>`. One of
each per eval is plenty; a check that runs the project's own tests needs neither.

## B. A task in this repository

The agent works in a copy of the repo; the project's own tests, plus one hidden test placed
after the turn, decide.

```ts
// evals/environments.ts
import { defineEnvironment } from 'reeval'

/** This repository as committed, without keys, runs or the evals themselves. */
export const repo = defineEnvironment('repo', ({ directory }) => ({
  files: directory('..', { glob: ['!.env*', '!.reeval/', '!evals/', '!reeval.config.*'] }),
  setup: [{ run: 'npm ci --no-audit --no-fund', timeout: '5m' }],
}))
```

```ts
// evals/slugify.eval.ts
import { evaluate, expect } from 'reeval'
import { repo } from './environments.ts'

evaluate('adds a slugify helper that passes a hidden test', { environment: repo }, async (c) => {
  await c.send('Add slugify(text) to src/strings.ts and export it from src/index.ts.')
  await c.writeFile(
    'test/slugify.hidden.test.ts',
    "import { slugify } from '../src/index.ts'\n" +
      "import { test, expect } from 'vitest'\n" +
      "test('slugify', () => expect(slugify('Hello, World!')).toBe('hello-world'))\n",
  )
  await expect(c.exec('npx vitest run test/slugify.hidden.test.ts'), 'hidden test').toSucceed()
  await expect(c.exec('npm test'), 'existing tests').toSucceed()
})
```

- `directory()` skips `node_modules/`, `dist/` and caches but not `.env*` or `.reeval/`: keep the
  `!` patterns, so keys never reach the sandbox and the agent can't read the evals, or the
  oracle's answer in `reeval.config.ts`.
- Use the project's install and test commands (`pnpm install --frozen-lockfile`, `pytest`, …).
  A toolchain other than Node goes in `sandbox: docker({ from: 'python:3.12-slim' })` on the
  environment.
- Choose a task the size of a small PR. A task the repo's tests can't see needs a hidden test.
- A big repo's whole suite can take minutes an attempt: check with its typecheck and the one
  spec the task touches.
- An install script that downloads a browser (puppeteer, Playwright) can fail in the sandbox.
  `npm ci --ignore-scripts` skips it, and the typecheck and most tests still run.

## D. A rules file, with and without

The repo has no skills, but it has agent rules (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`). The
control works in the repo without them; the variant gets the same file back as `rules`, which
reeval writes where its agent reads them. `acme-cli`'s `AGENTS.md` says that each user-facing
change adds a line to `CHANGELOG.md`, and that each module's test sits beside it as
`*.test.ts`. Neither shows in the code around a change.

```ts
// evals/environments.ts
import { defineEnvironment } from 'reeval'

/** This repository without its agent rules, keys, runs or the evals themselves. */
export const repo = defineEnvironment('repo', ({ directory }) => ({
  files: directory('..', {
    glob: ['!.env*', '!.reeval/', '!evals/', '!reeval.config.*', '!AGENTS.md'],
  }),
  setup: [{ run: 'npm ci --no-audit --no-fund --ignore-scripts', timeout: '10m' }],
}))

/** The same repository with its AGENTS.md. */
export const withRules = repo.extendEnvironment('with-agents-md', ({ file }) => ({
  rules: file('../AGENTS.md'),
}))
```

```ts
// evals/deploy-region.eval.ts
import { evaluate, expect } from 'reeval'
import { repo, withRules } from './environments.ts'

evaluate(
  'follows AGENTS.md on a user-facing CLI change',
  { compare: { baseline: repo, variants: [withRules] } },
  async (c) => {
    await c.send('`acme deploy` should stop with a clear error when no region is set.')
    expect.soft(c, 'a CHANGELOG.md entry').toHaveChanged('CHANGELOG.md')
    expect.soft(c, 'a test beside the code').toHaveChanged('src/**/*.test.ts')
    await expect.soft(c.exec('npx tsc --noEmit'), 'compiles').toSucceed()
  },
)
```

- Leave out every rules file the agent might read (`!AGENTS.md`, `!CLAUDE.md`, `!GEMINI.md`),
  and any doc that repeats the rules you check (`!CONTRIBUTING.md`): a control that still
  finds them isn't a control.
- A mature repo's conventions show in its code, so both arms often pass. That's the answer to
  "does the rules file change anything here?", and the eval stays useful as a regression check
  across models and harnesses.
- The prompt asks for the change, never for a changelog line or a test: that's what the rules
  file should add.
- `toHaveChanged` reads the attempt's diff, so it needs no oracle; a `compiles` check needs
  none either.

## C. A subject you researched

The user wants to know whether agents use Zod 4 correctly. Research found that Zod 4 moved string
formats to the top level (`z.email()`, not `z.string().email()`). The variant gets a short skill
you wrote from that research; the control gets nothing.

```md
<!-- skills/zod-4/SKILL.md -->
---
name: zod-4
description: Zod 4 APIs. Use when writing or changing code that uses zod.
---

# Zod 4

- String formats are top-level: `z.email()`, `z.url()`, `z.uuid()`, not `z.string().email()`.
- Error customization is one `error` param: `z.string({ error: 'Required' })`.
```

```ts
// evals/environments.ts
import { defineEnvironment } from 'reeval'

export const zod = defineEnvironment('zod-4', {
  files: { 'package.json': '{ "type": "module" }\n', '.gitignore': 'node_modules/\n' },
  setup: [{ run: 'npm i zod@4.1.12 --no-audit --no-fund', timeout: '3m' }],
})

export const withZodSkill = zod.extendEnvironment('with-zod-skill', ({ skill }) => ({
  skills: [skill.local('../skills/zod-4')],
}))
```

```ts
// evals/zod-email.eval.ts
import { evaluate, expect } from 'reeval'
import { withZodSkill, zod } from './environments.ts'

const accepts = `node -e "import('./user.js').then(({ User }) => {
  const ok = User.safeParse({ email: 'ada@example.com' }).success
  const bad = User.safeParse({ email: 'nope' }).success
  process.exit(ok && !bad ? 0 : 1)
})"`

evaluate(
  "uses Zod 4's top-level email format",
  { compare: { baseline: zod, variants: [withZodSkill] } },
  async (c) => {
    await c.send('Create user.js exporting a zod schema User with a required email field.')
    await expect.soft(c.exec(accepts), 'validates emails').toSucceed()
    const src = (await c.readFile('user.js')) ?? ''
    expect.soft(src, 'uses z.email()').toMatch(/z\.email\(/)
  },
)
```

- Pin the version you researched (`zod@4.1.12`), in the setup step and in what you tell the user.
- Write the facts down as a skill only if the user wants to know what docs or a skill would
  change. Otherwise drop the compare and keep `environment: zod`.
- Check behavior (`validates emails`) and the specific API (`uses z.email()`) as two labeled
  checks, so the result says which one an agent missed.
