# Quick-start templates

Copy the one that fits, then change the task, the checks and the names. Each is a whole eval:
`evals/environments.ts` plus one `evals/*.eval.ts`. Rerun `npx reeval run --dry-run` after every
edit.

## A. A skill, with and without

Say the project has `skills/acme-billing/SKILL.md`, and one of its rules is "money is an integer
number of cents, in a column whose name ends in `_cents`". A capable agent without the skill
writes `numeric(10,2)`, so the rule tells the arms apart. The task asks for the table, not the
rule.

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
  { compare: { baseline: plain, variants: [withSkill] }, runs: 2 },
  async (c) => {
    await c.send(
      `Write ${migration}: a Postgres migration creating an invoices table ` +
        'with a customer id, an issue date and the invoice total.',
    )
    const sql = ((await c.readFile(migration)) ?? '').toLowerCase()
    expect.soft(sql, 'creates invoices').toMatch(/create table[^;]*invoices/)
    expect.soft(sql, 'total in integer cents').toMatch(/\btotal\w*_cents\s+(big)?int/)
  },
)
```

Read the skill you're evaluating and choose its own most specific rule that a file or a command
can check; the example's rule is only a shape. A rule every agent already follows shows no lift
(both arms `2 of 2`), which is a real answer but a dull first run.

The canary: a profile in `reeval.config.ts` whose fake agent writes the wrong answer. Add
`fakeHarness` to the harness import.

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
```

`npx reeval run --profile canary --no-insights` runs it in the real Docker sandbox with no keys
(after `npx reeval image build`) and must exit 1. One canary per check you wrote yourself is
plenty; a check that reads the project's own test command needs none.

## B. A task in this repository

The agent works in a copy of the repo; the project's own tests, plus one hidden test placed
after the turn, decide.

```ts
// evals/environments.ts
import { defineEnvironment } from 'reeval'

/** This repository as committed, without keys, runs or the evals themselves. */
export const repo = defineEnvironment('repo', ({ directory }) => ({
  files: directory('..', { glob: ['!.env*', '!.reeval/', '!evals/'] }),
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
  `!` patterns, so keys never reach the sandbox.
- Use the project's install and test commands (`pnpm install --frozen-lockfile`, `pytest`, …).
  A toolchain other than Node goes in `sandbox: docker({ from: 'python:3.12-slim' })` on the
  environment.
- Choose a task the size of a small PR. A task the repo's tests can't see needs a hidden test.

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
- Error customisation is one `error` param: `z.string({ error: 'Required' })`.
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
  { compare: { baseline: zod, variants: [withZodSkill] }, runs: 2 },
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
- Check behaviour (`validates emails`) and the specific API (`uses z.email()`) as two labelled
  checks, so the result says which one an agent missed.
