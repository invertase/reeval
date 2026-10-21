# reeval

reeval (*/ree-val/*) is an open-source evaluation runner for developer tools.

Evaluate how coding agents discover and use SDKs, CLIs, MCP servers, skills, and docs across harnesses and changes.

Evaluations run inside isolated sandboxed environments, the output is stored in machine readable formats alongside your code, and reeval surfaces the real insights to improve your developer tool.

## Quick Start

Install reeval as a dev-dependency via npm:

```bash
npm i -D reeval
reeval init
```

After `init`, reeval creates a `reeval.config.ts` file and an example evaluation within `evals/greeting.eval.ts`. 

Next, use reeval to run the evaluations:

```bash
reeval run
```

To learn more:
 - [visit the documentation](https://docs.reeval.ai).
 - [use reeval studio to gain insights](https://docs.reeval.ai/studio).

## Example

An evaluation which surfaces whether changes to your skill has positive uplift vs the current one:

```ts
import { evaluate, defineEnvironment, expect } from 'reeval';

const baseSkill = defineEnvironment('base-skill', ({ skill }) => ({
  skills: [skill.git('github:my-org/developer-tool')],
));

const updatedSkill = defineEnvironment('updated-skill', ({ skill }) => ({
  skills: [skill.git('github:my-org/developer-tool', { ref: 'skill-update' })],
));

evaluate('that the new skill improves code output and efficiency',
  {
    compare: {
      baseline: baseSkill,
      variants: [updatedSkill],
      questions: [
        'Which agent followed the brand guidelines more closely?',
        'Which agent used the design tokens correctly without guessing?',
      ],
    },
  },
  async (c) => {
    // Send a prompt to the coding agent
    const turn = await c.send('Use skills to build an app which matches brand guidelines');

    // The agents must have called the skill to pass
    expect(turn).toHaveCalledSkill('brand-skill');

    // Pass judgement on the output
    expect(
      await c.judge('Does the app use the branding.css file to style visual components?')
    ).toPass();
  }
);
```

## Features

- **Sandboxed coding harnesses**: Support for popular coding harnesses; Cursor, Claude Code, Codex, Antigravity, OpenCode, Goose, Grok Build, pi & fx.
- **Isolated environments**: Define base images, skills, MCP, rules, tools and a workspace. Run evals in an isolated sandbox with those environments.
- **Assert & Judge**: Assert that a harness produced expected files, consumed tooling, and judge the output with a score.
- **Compare, question and analyze**: Compare the results and uplift from different harnesses and/or LLMs, and analyze the output across a matrix of runs.
- **Query results**: Use the built in SQLite database, or point your own LLM at the built in MCP server at results from your evals.
- **Studio**: Launch the local web studio to visulize your data, or export it as a static website.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). Copyright 2026 Invertase Limited.

The published package inlines some third-party code (the studio app's React, Radix UI and
shadcn/ui components, and Claude Code's patched adapter). Its `THIRD_PARTY_NOTICES.md`, generated
at build time, lists each of those packages with its version, licence and notices.
