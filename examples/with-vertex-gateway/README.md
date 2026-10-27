# with-vertex-gateway

**Shows:** an agent and its judge on Vertex AI, with no key. The `vertex` profile runs Claude Code
with `gateway: [vertex()]` and judges with a Claude model there too, so both are billed to your
Google Cloud project. reeval mints access tokens from your Application Default Credentials on the
host, and none enters the sandbox. The task: add `multiply(a, b)`, with a test.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. The `vertex` profile needs a Google Cloud project with the Vertex AI API enabled and Claude
Haiku 4.5 enabled in Model Garden, `GOOGLE_CLOUD_PROJECT` in `.env.local`, Application Default
Credentials, Docker, and `pnpm reeval image build --profile vertex` once:

```bash
gcloud auth application-default login
gcloud services enable aiplatform.googleapis.com --project <project id>
echo 'GOOGLE_CLOUD_PROJECT=<project id>' >> .env.local
pnpm reeval doctor --online
```

**Run:**

```bash
pnpm eval --profile vertex
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge, with no keys or Docker. The
agent copies the [`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent
would produce, so the checks have something to check. `pnpm eval --profile vertex` runs Claude
Code on Vertex AI, and `--profile <name>` runs any agent in
[`examples/profiles.ts`](../profiles.ts) on its own key.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `reeval doctor`'s `vertex` lines, then the plan's note. Offline, doctor
names the project and where tokens come from:

```text
✓ judge      anthropic/claude-haiku-4-5-20251001 in profile vertex: on vertex(), with a token from Application Default Credentials (the vertex check)
✓ gateway    gateway vertex in profile vertex: claude-code:claude-haiku-4-5-20251001 → vertex
✓ vertex     vertex() in profile vertex: project my-project (from GOOGLE_CLOUD_PROJECT), global
! vertex     no Application Default Credentials found (fine on a Google Cloud VM, whose metadata server serves them)
             fix: run gcloud auth application-default login, or set GOOGLE_APPLICATION_CREDENTIALS
```

With `--online`, it also mints a token and names its account, checks the Vertex AI API is
enabled, and asks Vertex for a free token count on each model, Claude Code's and the judge's.
A model the project can't call there gets the fix: enable it in Model Garden, or call it in
another region with `vertex({ regions: { anthropic: '<region>' } })`.

```text
eval                                                           harnesses  variants  runs  attempts  notes
with-vertex-gateway.eval.ts › adds a tested multiply function  1          —         1     1         gateway: claude-code:claude-haiku-4-5-20251001 → vertex
```

The model is the Anthropic API's dated id, which reeval sends to Vertex as
`claude-haiku-4-5@20251001`, so the same string works with `direct()` on `ANTHROPIC_API_KEY`.
Without a project in `GOOGLE_CLOUD_PROJECT` or `vertex({ project })`, the plan stops with exit 2.

| File | What it is |
|---|---|
| [`with-vertex-gateway.eval.ts`](./with-vertex-gateway.eval.ts) | The eval: one prompt, two checks and a judge |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, the `vertex` profile, and the real agents from `../profiles.ts` |

Vertex AI, fallback and pins are in the [Gateways](../../docs/reference/gateway.mdx) reference.
