# with-security-fix

**Shows:** fixing a SQL injection, checked by an exploit the agent never sees. `findUser()` builds
its query from the name it's given; the agent fixes it, the eval runs the tests, then writes a
hidden exploit test with `c.writeFile` and runs it. The exploit tries `' OR '1'='1`, and a real
name with a quote in it, so stripping quotes doesn't pass.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once. The database is Node's built-in
`node:sqlite`, so nothing needs `npm install`.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it's the fix, a bound parameter. `pnpm eval --profile claude-code`
runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** a fix that strips quotes from the name instead passes the tests and the
`' OR '1'='1` case, and fails on `Miles O'Brien`. The attempt's `checks/2.log`, under
`.reeval/runs/<run>/`, names the test:

```text
fail             fixes the SQL injection
  blocks the exploit  failed
    expected command to succeed, exit code 1
  +1 more passed
```

```text
not ok 2 - a name with a quote in it still matches
# pass 1
# fail 1
```

| File | What it is |
|---|---|
| [`with-security-fix.eval.ts`](./with-security-fix.eval.ts) | The eval: the fix, the tests, then the hidden exploit |
| [`project/`](./project) | The package the agent starts from: `src/users.js` and its tests |
| [`hidden/exploit.test.js`](./hidden/exploit.test.js) | The hidden exploit test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace: the fix |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`c.writeFile` and hidden checks are in the [Attempt context reference](../../docs/reference/context.mdx)
reference.
