# reeval

reeval (*/ree-val/*) is an open-source evaluation runner for developer tools.

Evaluate how coding agents discover and use SDKs, CLIs, MCP servers, skills, and docs across harnesses and changes.

Evaluations run inside isolated sandboxed environments, the output is stored in machine readable formats alongside the code, and reeval surfaces the real insights to improve the developer tool.

## Quickstart

```sh
npm i -D reeval
npx reeval init
npx reeval run
```

`reeval init` writes `reeval.config.ts` and `evals/greet.eval.ts`. `npx reeval run` runs it.

```ts
// evals/greet.eval.ts
import { evaluate, expect } from 'reeval'

const greetsAda = `node -e "import('./greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Hello, Ada!' ? 0 : 1))"`

evaluate('creates greet.js', async (c) => {
  const turn = await c.send(
    'Create greet.js, an ES module exporting `greet(name)` that returns "Hello, <name>!". No dependencies.',
  )

  expect(turn).toHaveFile('greet.js', /greet/)
  expect(await c.exec(greetsAda)).toSucceed()

  expect(await c.judge('There are no dependencies')).toPass();
})
```

```text
pass             creates greet.js  1/1

1 pass
```

Harnesses, keys, and sandboxes are in the [docs](docs/).

## What you can evaluate

### 1. Check which tools agents choose

Prompt for an outcome and leave the tool unnamed. The count is how many attempts named Genkit.

```ts
// evals/recommendation.eval.ts
import { evaluate, expect } from 'reeval'

const tasks = [
  {
    task: 'production workflows',
    prompt:
      'I’m building a production AI feature that needs reusable multi-step workflows, structured outputs, tool calling, local testing, observability, and deployment support; what development framework should I use and why?',
  },
  {
    task: 'structured outputs',
    prompt:
      'I need a framework for an AI feature that returns structured objects and calls tools. What should I use, and why that one?',
  },
  {
    task: 'local testing',
    prompt:
      'I need a framework I can test on a laptop before deploying an AI feature. What should I use, and why that one?',
  },
]

evaluate.each(tasks)('recommends a framework for $task', async (c, { prompt }) => {
  await c.send(prompt)

  expect(
    await c.judge('Pass if Genkit is mentioned as a recommended or viable solution.'),
    'names Genkit',
  ).toPass()

  expect(await c.judge('Pass if the reply states a reason for the choice.'), 'states a reason').toPass()

  expect(
    await c.judge('Pass if the reply recommends a single framework rather than a list of equals.'),
    'one framework',
  ).toPass()
})

```

```text
$ npx reeval run --profile nightly evals/recommendation.eval.ts

                 recommends a framework for $task
  fail  production workflows  Genkit 0/4
    named
    LangGraph  3/4
    Mastra     1/4
    Genkit     0/4
    searches   6
    +2 passed
  fail  structured outputs    Genkit 4/4
    named
    Genkit           4/4
    Pydantic AI      3/4
    states a reason  2/4
    +1 passed
  pass  local testing         Genkit 4/4
  next  reeval show --md

2 fail · 1 pass
```

### 2. Verify that agents finish the task

Pin a codebase, give the agent a task, and assert on the finished workspace.

```ts
// evals/reset-button.eval.ts
import { defineEnvironment, evaluate, expect } from 'reeval'

const reactTs = defineEnvironment('react-ts', ({ git }) => ({
  workspace: git('https://github.com/vitejs/vite', {
    ref: 'v6.0.0',
    path: 'packages/create-vite/template-react-ts',
    init: true,
  }),
}))

evaluate.each([
  {
    name: 'reset button',
    prompt: 'Add a Reset button to src/App.tsx that sets the count back to 0.',
  },
  {
    name: 'double button',
    prompt: 'Add a Double button to src/App.tsx that doubles the count.',
  },
])('adds a $name', { environment: reactTs }, async (c, { prompt }) => {
  const turn = await c.send(prompt)

  expect(turn.diff.files, 'touches the page').toEqual([{ path: 'src/App.tsx', status: 'modified' }])

  await expect(c.exec('npm run build'), 'build').toSucceed()
  await expect(c.exec('npx tsc --noEmit'), 'types').toSucceed()
})

```

```text
$ npx reeval run evals/reset-button.eval.ts

                 adds a $name
  pass  reset button   1/1
  fail  double button  0/1
    build              exit 1
      expected command to succeed, exit code 1
    types              not run
    +1 passed
  next  src/App.tsx

1 fail · 1 pass
```

### 3. Measure whether a change helped

Run the same task with a change and without it.

```ts
// evals/billing.eval.ts
import { defineEnvironment, evaluate, expect } from 'reeval'

const acmePlain = defineEnvironment('acme-plain', {})
const withSkill = acmePlain.extendEnvironment('acme-with-skill', ({ skill }) => ({
  skills: [skill.local('../skills/acme-billing')],
}))
const withDoc = acmePlain.extendEnvironment('acme-with-doc', ({ skill }) => ({
  skills: [skill.local('../skills/acme-billing-doc')],
}))

evaluate(
  'bills a customer with the acme-billing SDK',
  {
    environment: acmePlain,
    compare: { variants: [withSkill, withDoc] },
  },
  async (c) => {
    await c.send(
      'Add invoice.js exporting billCustomer(email, amountGbp) that sends an invoice for that ' +
        'amount with the acme-billing SDK in ./sdk/index.js. ES module, no dependencies.',
    )

    await expect(c.exec('node checks/exports-bill-customer.mjs'), 'exports-bill-customer').toSucceed()
    await expect(c.exec('node checks/sends-invoice.mjs'), 'sends-invoice').toSucceed()
    await expect(c.exec('node checks/amount-in-minor-units.mjs'), 'amount-in-minor-units').toSucceed()
    await expect(c.exec('node checks/currency-code.mjs'), 'currency-code').toSucceed()
  },
)

```

```text
$ npx reeval run --profile nightly evals/billing.eval.ts

fail             bills a customer with the acme-billing SDK
  arm              pass
  acme-plain       0/4
  acme-with-skill  0/4
  acme-with-doc    4/4   helped
  check                  acme-plain  acme-with-skill  acme-with-doc
  sends-invoice          0/4         4/4              4/4
  amount-in-minor-units  not run     0/4              4/4
    expected 1250 for 12.50 GBP, got 12.5
  currency-code          not run     not run          4/4
  +1 passed
  effort           tools  agent  tokens
  acme-plain       3      19s    8.9k
  acme-with-skill  3      14s    6.2k
  acme-with-doc    4      17s    7.0k
  next             skills/acme-billing

1 fail
```

### 4. Compare across agent harnesses

Write the task once and run it on each harness.

```ts
// evals/greeting.eval.ts
import { defineEnvironment, evaluate, expect } from 'reeval'
import { antigravity, claudeCode, codex, cursor } from 'reeval/harness'

const withSkill = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

const greetAda = `node -e "import('./greet.js').then((m) => {
  const out = (m.greet ?? m.default)('Ada')
  process.exit(out === 'Ahoy, Ada!' ? 0 : 1)
})"`

const signOff = `node -e "import('./greet.js').then((m) => {
  const out = (m.signOff ?? m.default)()
  process.exit(out === 'Ahoy.' ? 0 : 1)
})"`

evaluate(
  'greets in the house style',
  {
    environment: withSkill,
    harness: [
      cursor({ model: 'composer-2.5' }),
      claudeCode({ model: 'claude-sonnet-5' }),
      antigravity({ model: 'gemini-3.8-flash-medium' }),
      codex({ model: 'gpt-5.6-luna' }),
    ],
  },
  async (c) => {
    await c.send(
      'Create greet.js exporting greet(name) that greets the person in our house greeting style, ' +
        'and signOff() that returns the house sign-off. Add a package.json with "type": "module". ' +
        'No dependencies.',
    )

    await expect(c.exec('test -f package.json'), 'package.json').toSucceed()
    await expect(c.exec(greetAda), 'house greeting').toSucceed()
    await expect(c.exec(signOff), 'sign-off').toSucceed()
  },
)

```

```text
$ npx reeval run evals/greeting.eval.ts

fail             greets in the house style
  harness                              pass
  cursor:composer-2.5                  1/1
  claude-code:claude-sonnet-5          1/1
  antigravity:gemini-3.8-flash-medium  0/1
    house greeting                     exit 1
    sign-off                           not run
    +1 passed
  codex:gpt-5.6-luna                   1/1
  next                                 reeval show --md

1 fail
```

### 5. Catch regressions before release

Commit a run, then compare a pull request with that baseline.

```ts
// reeval.config.ts
import { defineConfig } from 'reeval'

export default defineConfig({
  defaultProfile: { local: 'local', ci: 'pr' },
  profiles: {
    local: { defaults: { runs: 1 } },
    pr: {
      limit: { runs: 1, compare: false, harness: ['cursor:composer-2.5'] },
      budget: { attempts: 20 },
    },
    nightly: { defaults: { runs: 4 }, record: 'always' },
  },
})

```

```text
$ npx reeval run --profile pr && npx reeval compare --fail-on-regression

not comparable   bills a customer with the acme-billing SDK
  part             environment
  base             20261016T091402Z_a1b2c3d_ci_hz13
  head             20261019T093118Z_9f8e7d6_ci_rw73

regressed        greets in the house style
  base             20261016T091402Z_a1b2c3d_ci_hz13
  head             20261019T093118Z_9f8e7d6_ci_rw73
  house greeting   pass → fail
    exit 1
  sign-off         not run
  +1 passed
  next             reeval show --md 20261019T093118Z_9f8e7d6_ci_rw73

+4 same

fixed            adds a double button
  base             20261016T091402Z_a1b2c3d_ci_hz13
  head             20261019T093118Z_9f8e7d6_ci_rw73
  build            fail → pass

1 regressed · 1 fixed · 1 not comparable · 4 same
```

## After the run

- `npx reeval show --md` prints a run, including the agent's replies.
- `npx reeval query` is read-only SQL over recorded runs.
- `npx reeval analyze` explains a run in one model call.
- `npx reeval mcp` serves that history to another agent.
- `npx reeval studio` opens the transcript, diff, and checks in the browser.

Guide, recipes, and reference: [docs/](docs/).

## Licence

Apache License, Version 2.0. Copyright 2026 Invertase Limited. [oss@invertase.io](mailto:oss@invertase.io).
