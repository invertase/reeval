# Accuracy template

Use when the tool is already chosen and the question is "does the agent's code work against the
current SDK?". The fixture pins the SDK version; the prompt names the tool and the job. Checks
are deterministic wherever code can be checked (a typecheck against the installed types, a
hidden test, a search for deprecated calls), and a judge covers only what code can't show.

```ts
// evals/discoverability/accuracy.eval.ts
import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'
import { suite } from './suite.ts'

// package.json pins "acme-sdk": "4.2.0" and TypeScript, so a typecheck catches
// an invented method or option against the version you researched.
const sdkApp = defineEnvironment('acme-sdk-app', ({ directory }) => ({
  files: {
    ...directory('./fixtures/acme-sdk-app'),
    '.gitignore': 'node_modules/\n',
  },
  setup: [{ run: 'npm ci', timeout: '5m' }],
}))

// Calls handleWebhook with a correctly signed request and a tampered one,
// against a stand-in for the SDK's API. Placed after the turn, never seen.
const hidden = readFileSync(
  new URL('./hidden/webhook.test.ts', import.meta.url),
  'utf8',
)

evaluate(
  'writes a working acme-sdk webhook handler',
  { ...suite, environment: sdkApp },
  async (c) => {
    await c.send(
      'Write src/webhook.ts exporting handleWebhook(req) that verifies the ' +
        "request's signature with acme-sdk and answers 400 when it fails.",
    )

    await expect.soft(c.exec('npx tsc --noEmit'), 'typechecks').toSucceed()
    const source = (await c.readFile('src/webhook.ts')) ?? ''
    // A method the changelog deprecated, which older training data still uses.
    expect.soft(source, 'no deprecated call').not.toMatch(/\bverifyLegacy\(/)
    const manifest = (await c.readFile('package.json')) ?? ''
    expect.soft(manifest, 'keeps 4.2.0').toContain('"acme-sdk": "4.2.0"')

    await c.writeFile('webhook.test.ts', hidden)
    await expect.soft(
      c.exec('node --experimental-strip-types --test webhook.test.ts'),
      'verifies signatures',
    ).toSucceed()

    // The one thing no check above sees: it could pass with hand-rolled crypto.
    expect.soft(
      await c.judge(
        "Does handleWebhook rely on the SDK's verification rather than its own?",
        { state: { diff: ['src/'] } },
      ),
      'uses the SDK',
    ).toPass()
  },
)
```

## Adapting it

- Draw the tasks from what breaks for real users: the deprecation errors, migration guides and
  "this method doesn't exist" issues in the tool's tracker. A "fix this deprecation error" case
  seeds the old call in the fixture and checks it's gone and the typecheck passes.
- Run the hidden test with the fixture's own test runner and a stand-in server, so it needs no
  live credentials. A check that must call the real service needs a brokered secret; see the
  reeval skill's environments reference.
- The canary writes the deprecated call or an invented option and must fail `typechecks` or
  `no deprecated call`; the oracle writes a correct handler another way than you would.
