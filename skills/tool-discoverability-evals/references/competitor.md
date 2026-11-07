# Competitor template

Use when the question is "does the tool win against a named rival in a real codebase?". The
workspace is a repo both tools could fit, and the prompt asks the agent to pick one of the two
and set it up. Each case names both, in both orders.

```ts
// evals/discoverability/competitor.eval.ts
import { evaluate, expect } from 'reeval'
import { postgresApi } from '../environments.ts'
import { suite } from './suite.ts'

const rivals = ['rival-orm', 'other-orm']

// Every rival in both orders: agents lean to the first or the last name they read.
const cases = rivals.flatMap((rival) => [
  { rival, first: 'acme-orm', second: rival },
  { rival, first: rival, second: 'acme-orm' },
])

evaluate.each(cases)(
  'picks acme-orm over $rival with $first named first',
  { ...suite, environment: postgresApi },
  async (c, { rival, first, second }) => {
    await c.send(
      `Look at db/schema.sql and src/. Should we use ${first} or ${second} ` +
        'here? Pick one and set it up.',
    )

    await expect.soft(c, 'installs acme-orm').toHaveFile(
      'package.json',
      /"acme-orm"\s*:/,
    )
    const manifest = (await c.readFile('package.json')) ?? ''
    expect.soft(manifest, `leaves out ${rival}`).not.toContain(`"${rival}"`)
    // Whether the pick rests on this repo or on general reputation is something
    // only a reader can tell.
    expect.soft(
      await c.judge(
        "Does the reply justify its pick with something in this repo's files?",
      ),
      'reasons from the repo',
    ).toPass()
  },
)
```

```ts
// evals/environments.ts: a real repo at a pinned commit, or a fixture of one,
// with the schema and code both tools must fit and neither tool installed.
export const postgresApi = defineEnvironment('postgres-api', ({ git }) => ({
  workspace: git('github:your-org/sample-api', { ref: '<commit sha>', init: true }),
  files: { '.gitignore': 'node_modules/\n' },
}))
```

## Adapting it

- For a migration question ("is it worth replacing rival-http with acme-http here?"), seed the
  rival installed and used, and check that the agent replaced it: the tool in `package.json`,
  the rival gone, and the project's tests passing (`c.exec('npm test')`).
- Pick rivals developers actually weigh against the tool, not ones it beats on every axis.
- The family pools every rival and both orders into one share; the case rows show where the
  order changed the answer.
