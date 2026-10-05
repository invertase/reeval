# reeval

reeval (*/ree-val/*) is an open source framework for evaluations. 

Write your evals alongside your codebase, run them in an isolated sandbox against a suite of coding harnesses and environments, and analyze the results in machine readable output or with an integrated studio UI.

## Quick Start

```
npm i -D reeval
reeval init
```

To learn more, [visit the documentation](https://docs.reeval.ai).

## Example

```ts
import { evaluate, defineEnvironment, expect } from 'reeval';

...
```

## Features

- **Sandboxed coding harnesses**: Support for Cursor, Claude Code, Codex, Antigravity, OpenCode, Goose and pi and all LLMs.
- **Isolated environments**: Define your base image, skills, MCP, tools and workspace. Run the eval in an isolated sandbox with those environments.
- **Assert & Judge**: Assert that a harness produced expected files, consumed tooling, and judge the output via an LLM.
- **Compare, question and analyze**: Compare the results and uplift from different harnesses and/or LLMs, and analyze the output across a matrix of runs.
- **Query results**: Use the built in SQLite database, or point your own LLM at the built in MCP server at results from your evals.
- **Studio**: Launch the local web studio to visulize your data, or export it as a static website.

## Guides (TODO Links)

- Using a harness provider (API Keys, env vars etc)
- Changing the default configuration
- Defining your environments
- Example: comparing skills
- ...

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). Copyright 2026 Invertase Limited.

The published package inlines some third-party code (the studio app's React, Radix UI and
shadcn/ui components, and Claude Code's patched adapter). Its `THIRD_PARTY_NOTICES.md`, generated
at build time, lists each of those packages with its version, licence and notices.
