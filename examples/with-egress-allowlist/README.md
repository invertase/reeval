# with-egress-allowlist

**Shows:** an allowlist of hosts. The eval sets `egress: { allow: [...DEFAULT_EGRESS_ALLOW,
'example.com'] }`: the package registries and GitHub, plus one site, with the agent's own API
allowed on top. The agent writes `title.js`, which fetches `https://example.com`, and the eval
checks it works and that another host is refused.

**Needs:** Docker, even for the fake agent, and the network; in this repo, run
`pnpm install && pnpm build` at the root first. A real agent also needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code) and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on Claude
Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the plan's notes list the policy, and `pnpm eval -v` shows one host allowed
and one refused:

```text
eval                                                             harnesses  variants  runs  attempts  notes
with-egress-allowlist.eval.ts › fetches a page from an allowed…  1          —         1     1         egress: allow registry.npmjs.org, registry.yarnpkg.com, github.com, *.github.com, *.githubusercontent.com, pypi.org, files.pythonhosted.org, example.com
…
[fetches#1 fake] 15:02:42 gateway   CONNECT example.com:443 → 200 · allowed · ↑1.8 KB ↓6.2 KB · 60ms · no key substituted
[fetches#1 fake] 15:02:43 gateway   CONNECT example.org:443 → 403 · blocked: example.org isn't in the allowlist · ↑0 B ↓0 B · 0ms · no key substituted
```

Under a real agent the notes end with `+ auto:` and its API's hosts. `*.example.com` in `allow`
matches subdomains.

| File | What it is |
|---|---|
| [`with-egress-allowlist.eval.ts`](./with-egress-allowlist.eval.ts) | The eval: the allowlist, one prompt, three checks |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent in Docker, and the real agents from `../profiles.ts` |

Egress policies are in the [Secrets and egress](../../docs/guide/secrets-and-egress.mdx) guide, and
what each enforces in [Egress](../../docs/concepts/egress.mdx).
