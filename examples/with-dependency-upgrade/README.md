# with-dependency-upgrade

**Shows:** bumping a dependency across a breaking change. The package formats receipts with
`strfmt` 1.4.0; 2.0.0 swaps `%s` for named `{name}` placeholders. The agent moves the import to
2.0.0 and adapts the call sites, and the eval checks `package.json`, runs `npm test` and guards the
tests and `vendor/` with `not.toHaveChanged`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

Both versions of `strfmt` are vendored in [`project/vendor/`](./project/vendor) and picked by
`package.json`'s `"imports"`, so nothing needs `npm install` or the registry. For a real package,
seed its lockfile and add `setup: ['npm ci']` to the environment.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** an agent that bumps the version and leaves the call sites alone fails on the
tests, while the version check passes:

```text
fail             upgrades strfmt across its breaking change
  toSucceed npm test  failed
    expected command to succeed, exit code 1
  +1 more passed
```

| File | What it is |
|---|---|
| [`with-dependency-upgrade.eval.ts`](./with-dependency-upgrade.eval.ts) | The eval: the upgrade and three checks |
| [`project/`](./project) | The package the agent starts from, with both `strfmt` versions in `vendor/` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace: the new import and call sites |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Seeding files and `setup` steps are in the [Environments](../../docs/guide/environments.mdx) guide.
