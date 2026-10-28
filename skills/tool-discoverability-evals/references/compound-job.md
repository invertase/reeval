# Compound-job template

Use when the tool wins on fit rather than as the category default: a runtime, a host, a
compliance rule or a cost limit rules out the usual choice. The environment pins the stack the
way a real repo does, and the prompt adds the one constraint a developer would type.

```ts
// evals/discoverability/compound-job.eval.ts
import { evaluate, expect } from 'reeval'
import { edgeApp } from '../environments.ts'
import { suite } from './suite.ts'

// The task plus one constraint. The stack itself (the runtime, the host) comes
// from the fixture's files, so the prompt doesn't repeat it.
const asks = [
  {
    job: 'rate limiting',
    prompt: 'Add a per-user rate limit to the API without running Redis ourselves.',
  },
  {
    job: 'background jobs',
    prompt: 'Send the welcome email in the background; we run no servers.',
  },
  // … six or more, each a job the tool does under a constraint it meets
]

evaluate.each(asks)(
  'picks acme-edge for $job on an edge runtime',
  { ...suite, environment: edgeApp },
  async (c, { prompt }) => {
    await c.send(prompt)
    await expect.soft(c, 'installs acme-edge').toHaveFile(
      'package.json',
      /"acme-edge"\s*:/,
    )
    // The constraint is the point of the case: a choice that breaks it is a
    // miss, and only reading the code can tell.
    expect.soft(
      await c.judge(
        'Does the change work within the constraint the request states, ' +
          'without a service or runtime the request rules out?',
        { state: { diff: ['src/'] } },
      ),
      'meets the constraint',
    ).toPass()
  },
)
```

```ts
// evals/environments.ts: the stack lives in the files an agent reads first,
// the manifest and the platform config, not in a note addressed to the agent.
export const edgeApp = defineEnvironment('edge-app', ({ directory }) => ({
  files: {
    ...directory('./fixtures/edge-app'), // package.json, wrangler.toml, src/index.ts
    '.gitignore': 'node_modules/\n',
  },
  setup: [{ run: 'npm install', timeout: '5m' }],
}))
```

## Adapting it

- One stack per environment. To measure the tool on two stacks, define two environments and
  run the cases in each, not one fixture with both.
- Keep the constraint the developer types to one clause. A prompt that lists every reason the
  default fails has written the answer.
- If the tool isn't the right answer for a constraint, leave that case out: the suite measures
  where the tool should win.
