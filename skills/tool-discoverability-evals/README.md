# Coding-agent AEO

Answer engine optimization for coding agents is whether an agent picks your library when a
developer asks it to build something. Developers rarely name a library. They ask for a feature,
a fix or a design, and the agent chooses the dependency, installs it and writes the code. A
library that never comes up stays invisible. A library whose first code fails gets removed.

## The stack is already in the prompt

A coding agent reads the repo before it answers: the manifest (`package.json`,
`pyproject.toml`, `go.mod`), the directory layout and the code around the change. A Next.js app
with a Vercel config has already told it the framework and the host. Developers type a build
command or an architecture question, and the agent installs what it needs. Constraints that live
in the repo are part of the request before anyone types them.

## Six kinds of prompt

Each kind is a moment in how a developer ends up on a library.

### Discovery

A broad request that names no library: "Add authentication to this app." "Set up end-to-end
testing for this repo." "What should I use for validation here?" This is whether the library is
the agent's default for that category, when nothing else steers the choice.

### Compound-job

A task plus one technical constraint, typed by the developer or already in the repo. "Add a rate
limiter that works on Cloudflare Workers without running Redis." "Set up background jobs for
this Next.js App Router project on Vercel." "Recommend an ORM that supports Turso and starts
with no cold start." A library that is not the category default can still win when the
constraint rules the default out.

### Validation

A check, before anything is installed, that a named tool can do the job. "Does this auth
provider support custom SAML on the pro plan, or do we need another?" "Can this email API parse
inbound mail with attachments?" "Does this product's Node SDK run at the edge?" This is whether
the agent knows a real capability. A wrong "no" sends the developer elsewhere. A wrong "yes"
fails later.

### Competitor

A choice between two named dependencies for this codebase, or a question about migrating. "Look
at our schema: Drizzle or Prisma? Pick one." "Is it worth replacing Axios with Ky or fetch
here?" "Pinecone or pgvector for this Postgres setup?" The agent weighs bundle size, type
safety, latency and developer experience against the files it can see.

### Market perception

An architecture question asked before any vendor is named. "How should I architect feature flags
and A/B tests for a low-latency API?" "What's the best pattern for webhook retries and
idempotency in Go?" "What should I look for in state management for a large React Native app?"
This is whether the pattern the agent recommends is the one your product implements. When it is,
the developer arrives at your category already convinced.

### Accuracy

The library is already chosen, and the agent has to write working, current code. "Write a
webhook handler with the Stripe Node SDK that verifies signatures." "Configure Tailwind v4 in
this Vite project." "Fix this deprecation in our LangChain retrieval pipeline." This catches
deprecated methods and invented flags. Broken first-pass code is what makes a developer remove
the library.
