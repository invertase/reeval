# Discoverability in coding agents

Background for the `tool-discoverability-evals` skill. The procedure is in
[SKILL.md](SKILL.md); this page explains why a discoverability suite is shaped the way it is.

## What discoverability means

A developer rarely asks a coding agent "should I use library X?". They ask for a feature, a fix
or a design, and the agent picks the dependency, installs it and writes the code. A tool is
discoverable when agents pick it for the jobs it fits, and usable when the code they write with
it runs the first time. A tool that loses either step loses the developer: an agent that never
suggests it hides it, and an agent that suggests it and writes broken code gets it uninstalled.

## The repo is part of the prompt

Coding agents read the workspace before they answer: the manifest (`package.json`,
`pyproject.toml`, `go.mod`), config files, the directory layout and the code around the change.
So the stack is already in the prompt before the developer types a word. A Next.js project with
a `vercel.json` tells the agent the framework and the host; a `drizzle.config.ts` tells it the
ORM.

Two consequences for an evaluation:

- **The fixture is a prompt.** What you seed into the workspace steers the answer as much as
  what you send. A fixture that already lists the tool, or its rival, has answered the question.
- **Prompts stay short and realistic.** Developers issue build commands ("add auth") and
  architecture questions, and let the agent install what it needs. Put constraints in the repo
  where a real project would have them, and only add the one constraint a developer would type.

## The six prompt types

Each type is a different moment in a developer's choice of a tool, and each tests something
the others don't.

### Discovery

A broad, unopinionated request in a category: build a feature without naming a library ("add
authentication to this app", "set up end-to-end tests for this repo", "what should I use for
validation here?"). It tests whether the tool is the agent's default for that category, the
answer it gives when nothing else steers it.

### Compound-job

A task plus a technical constraint, typed by the developer or read from the codebase: a
runtime, a host, a compliance rule, a cost limit ("background jobs for this App Router project
on Vercel", "a rate limiter on an edge runtime without running Redis"). It tests long-tail fit:
a tool that isn't the category default can still win when the constraints rule out the default.

### Validation

A planning-mode check before anything is installed: does the tool support this requirement?
("Does this SDK work in an edge runtime?", "Does this plan support SAML?") It tests whether the
agent knows the tool's real capabilities. An agent that wrongly says "no" steers the developer
away; one that wrongly says "yes" sets up a failure later.

### Competitor

Pick one dependency over another for this codebase, or decide whether to migrate ("look at our
schema: should we use one ORM or the other here? Pick one."). It tests which tool wins when the
agent weighs bundle size, type safety, latency and developer experience against the actual
files, with both names in front of it.

### Market perception

An architecture question before any vendor is named ("how should I architect feature flags for
a low-latency API?", "what's the best pattern for webhook retries?"). It tests whether the
pattern the agent recommends is the one the tool implements. When the recommended design matches
how the tool works, the developer arrives at the tool's category already convinced.

### Accuracy

The tool is already chosen, and the agent must write working, current code with it ("write a
webhook handler with this SDK that verifies signatures", "configure version 4 of this tool in
this project", "fix this deprecation error"). It tests for deprecated methods, invented options
and wrong imports. This is where discoverability turns into retention: broken first-pass code
makes the developer remove the library.

## Reading the results

Discoverability results are shares, not a pass or fail bar: the share of attempts, per agent,
that picked the tool or got its code right. A low share is the finding the suite exists to
produce. Compare shares across agents and over time, and pair the types: high discovery with
low accuracy means agents find the tool and then fail with it; high accuracy with low discovery
means the tool works for agents that are told to use it, but none choose it.
