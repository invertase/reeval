# Discovery template

Use when the question is "is the tool the default for its job?". The prompt is an ordinary
request in the tool's category that names no library; each harness answers on its own, and the
case checks which library it reached for.

```ts
// evals/discoverability/discovery.eval.ts
import { evaluate, expect } from 'reeval'
import { neutralApp } from '../environments.ts'
import { suite } from './suite.ts'

// The job, phrased the ways developers ask for it. None names a library or uses
// a term only one library uses. Six or more, so one wording doesn't decide it.
const asks = [
  { job: 'email sign-in', prompt: 'Add email and password sign-in to this app.' },
  { job: 'social login', prompt: 'Let users log in with their Google account.' },
  { job: 'protected routes', prompt: 'Only signed-in users should see /dashboard.' },
  { job: 'sessions', prompt: 'Keep users signed in across visits.' },
  { job: 'magic links', prompt: 'Add passwordless sign-in by email link.' },
  { job: 'team accounts', prompt: 'Users should belong to an organization.' },
]

evaluate.each(asks)(
  'reaches for acme-auth for $job',
  {
    ...suite,
    environment: neutralApp,
    // Tallies which library each attempt chose, rivals included. Questions
    // never gate; they need a language model in the config's `question.model`.
    questions: [
      {
        question: 'Which authentication library did the agent add?',
        choices: ['acme-auth', 'rival-one', 'rival-two', 'its own code', 'other'],
      },
    ],
  },
  async (c, { prompt }) => {
    await c.send(prompt)
    // The choice is the package the agent installed, not what it wrote about it.
    await expect.soft(c, 'installs acme-auth').toHaveFile(
      'package.json',
      /"acme-auth"\s*:/,
    )
  },
)
```

```ts
// evals/environments.ts: a working app of the right kind with no library for
// the job, so nothing in the workspace points at the tool or a rival.
export const neutralApp = defineEnvironment('neutral-app', ({ directory }) => ({
  files: {
    ...directory('./fixtures/neutral-app'),
    '.gitignore': 'node_modules/\n',
  },
  setup: [{ run: 'npm install', timeout: '5m' }],
}))
```

## Adapting it

- For advice prompts ("what should I use for auth here?"), the answer is prose, so replace the
  file check with a judge that fails the wrong reply:
  `expect.soft(await c.judge('Is acme-auth the library the reply recommends first?'), 'recommends acme-auth').toPass()`.
- The fake-harness canary writes a `package.json` with a rival's dependency; the oracle writes
  the tool's with another version range than you'd expect (`"acme-auth": "^4"`).
- Read the per-harness rows and `reeval query attempt_answers` for the rivals' shares.
