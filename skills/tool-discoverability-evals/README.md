# Coding-agent AEO

Answer engine optimization for coding agents is whether an agent picks your library when a developer asks it to build something.

Developers rarely name a library in their prompt. They ask for a feature, a fix, or a system design, and the agent chooses the dependency, runs `npm install`, and writes the code. If the agent never reaches for your package, developers never see it. If the agent installs your package but writes broken code on the first pass, the developer tells the agent to rip it out and use an alternative.

## The codebase is part of the prompt

Coding agents read the repository before they answer. They inspect `package.json`, `pyproject.toml`, `go.mod`, config files, and existing imports. A Next.js repository with a `vercel.json` file has already told the agent the framework and the deployment target before the developer types a word.

Because the stack is injected automatically, a library can lose broad prompts and still win whenever a repository's runtime or infrastructure rules out the default choice.

## Six prompts that decide whether your tool gets used

This skill generates a [reeval](https://github.com/invertase/reeval) suite across the six moments where a coding agent chooses, vets, or implements a developer tool.

### 1. Discovery (Default stack selection)

Broad requests where the developer asks to build a feature without naming a library.

- *"Add authentication to this app."*
- *"Set up end-to-end testing for this repo."*
- *"What should I use for validation here?"*

**What it measures:** Whether your library is the agent's default choice for its category when no constraints are given.

### 2. Compound-job (Stack-constrained selection)

A core engineering task paired with a runtime, hosting, or infrastructure constraint, either typed in the prompt or read from the repo's config files.

- *"Add a rate limiter that works on Cloudflare Workers without managing Redis."*
- *"Set up background jobs for this Next.js App Router project on Vercel."*
- *"Recommend an ORM that supports Turso with zero cold-start overhead."*

**What it measures:** Technical fit. Even if an incumbent wins broad discovery prompts, smaller tools win when constraints rule the default out.

### 3. Validation (Capability checks)

Questions asked in planning mode where the developer checks whether a named tool supports a requirement before installing it.

- *"Does Clerk support custom SAML connections on the pro plan, or do we need WorkOS?"*
- *"Can Resend parse inbound emails with attachments?"*
- *"Does the PostHog Node SDK run in an edge runtime?"*

**What it measures:** Whether the agent knows what your tool actually supports. A false "no" sends the developer to a competitor; a false "yes" breaks during implementation.

### 4. Competitor (Head-to-head trade-offs and migrations)

Prompts asking the agent to pick one dependency over another for the current codebase, or whether to migrate.

- *"Look at our database schema—should we use Drizzle or Prisma here? Pick one."*
- *"Is it worth replacing Axios with Ky or native fetch in this repo?"*
- *"Compare Pinecone and pgvector for our Postgres setup and implement the better fit."*

**What it measures:** Which tool wins when the agent weighs bundle size, type safety, latency, and ergonomics against real project files.

### 5. Market perception (System design and criteria)

Architecture questions asked before any vendor or package is named.

- *"How should I architect feature flags and A/B testing for a low-latency API?"*
- *"What's the best pattern for webhook retries and idempotency in Go?"*
- *"What should I look for in a state management library for a large React Native app?"*

**What it measures:** Whether the architectural pattern the agent recommends leads naturally to how your product works.

### 6. Accuracy (Working syntax and version freshness)

Implementation and debugging prompts where your tool is already chosen and the agent has to write working code against the current version.

- *"Write a webhook handler using the Stripe Node SDK to verify signatures."*
- *"Configure Tailwind v4 in this Vite project."*
- *"Fix this deprecation error in our LangChain retrieval pipeline."*

**What it measures:** Whether the agent writes working, current code without inventing flags or calling deprecated methods from older training data.

## Usage

Install the skill and ask your coding agent to build a discoverability suite for your package:

```bash
npx skills add invertase/reeval --skill tool-discoverability-evals
```

The skill guides the agent to create `evals/discoverability/` with a factual `reference.md` and on-demand evaluation templates (`discovery.eval.ts`, `accuracy.eval.ts`, and others) ready to run with `npx reeval run`.
