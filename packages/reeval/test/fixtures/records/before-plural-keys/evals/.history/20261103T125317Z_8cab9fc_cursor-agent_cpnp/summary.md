# reeval run 20261103T125317Z_8cab9fc_cursor-agent_cpnp

3 fail · started 2026-11-03T12:53:17.244Z (891ms)

Plan: 3 evals · 5 cells · 5 attempts

## Results

```text
                 discovery: %s
  fail  add user authentication
    arm                  pass
    plain                0 of 1
    with-skill           0 of 1
    check                plain   with-skill
    toHaveFile greet.js  0 of 1  0 of 1
      expected file greet.js to exist
  fail  add social login and email/password auth
    arm                  pass
    plain                0 of 1
    with-skill           0 of 1
    check                plain   with-skill
    toHaveFile greet.js  0 of 1  0 of 1
      expected file greet.js to exist
  pass  all cases
    arm            pass
    plain          0 of 2
    with-skill     0 of 2  same

fail             renamed options › writes greet.js
  toHaveFile greet.js  failed  evals/options.eval.ts:11
    expected file greet.js to exist
  snapshot             .reeval/runs/20261103T125317Z_8cab9fc_cursor-agent_cpnp/evals-options-eval-ts-renamed-options-writes-greet-js-b9f9b0/fake-app-fake-e80a19/1/snapshots/final

3 fail

Remarks:
  discovery: %s: The with-skill variant, pooled over 2 cases: the same, but a family's lift needs 6 to hold.
    fix  evals/discovery.eval.ts:9  add cases, so the pooled lift has 6 to hold on
```

## State

| | |
|---|---|
| Executed at | 8cab9fcb3828 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | app eca09e8f139f; plain eca09e8f139f; with-skill eca09e8f139f |
| Judge | none by default · threshold 0.8 · version 991ce2915785 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.13 · @reeval/harness-opencode 0.2.13 · @reeval/harness-goose 0.1.10 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.8 · @ai-sdk/harness-claude-code 1.0.171-patch.8cc1b324 · @reeval/harness-codex 0.1.10 · @reeval/harness-fx 0.1.5 · @reeval/harness-grok-build 0.1.8 · ai 7.0.156 · @ai-sdk/harness 1.0.167 · @ai-sdk/anthropic 4.0.91 · @ai-sdk/google 4.0.107 · @ai-sdk/openai 4.0.104 · @ai-sdk/typesafe-ai 3.0.29 |
| reeval | 0.18.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261103T125317Z_8cab9fc_cursor-agent_cpnp.json](../20261103T125317Z_8cab9fc_cursor-agent_cpnp.json) · artifacts: all

## Attempts

### ✗ evals/discovery.eval.ts › discovery: add user authentication

#### ✗ fake/with-skill/fake#1

**assertion**

```
expected file greet.js to exist
```

- Prompt (completed, 0ms): add user authentication
- Time: setup 29ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-discovery-eval-ts-discovery-add-user-authentication-e8dd58/fake-with-skill-fake-14b6ac/1/transcript.jsonl) · [diff](evals-discovery-eval-ts-discovery-add-user-authentication-e8dd58/fake-with-skill-fake-14b6ac/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-discovery-eval-ts-discovery-add-user-authentication-e8dd58/fake-with-skill-fake-14b6ac/1/snapshots/final)
#### ○ fake/plain/fake#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected file greet.js to exist
```

- Prompt (completed, 0ms): add user authentication
- Time: setup 30ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-discovery-eval-ts-discovery-add-user-authentication-e8dd58/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-discovery-eval-ts-discovery-add-user-authentication-e8dd58/fake-plain-fake-57f9db/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-discovery-eval-ts-discovery-add-user-authentication-e8dd58/fake-plain-fake-57f9db/1/snapshots/final)

</details>

### ✗ evals/discovery.eval.ts › discovery: add social login and email/password auth

#### ✗ fake/with-skill/fake#1

**assertion**

```
expected file greet.js to exist
```

- Prompt (completed, 0ms): add social login and email/password auth
- Time: setup 26ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-discovery-eval-ts-discovery-add-social-login-and-email-ea6ace/fake-with-skill-fake-14b6ac/1/transcript.jsonl) · [diff](evals-discovery-eval-ts-discovery-add-social-login-and-email-ea6ace/fake-with-skill-fake-14b6ac/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-discovery-eval-ts-discovery-add-social-login-and-email-ea6ace/fake-with-skill-fake-14b6ac/1/snapshots/final)
#### ○ fake/plain/fake#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected file greet.js to exist
```

- Prompt (completed, 1ms): add social login and email/password auth
- Time: setup 34ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-discovery-eval-ts-discovery-add-social-login-and-email-ea6ace/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-discovery-eval-ts-discovery-add-social-login-and-email-ea6ace/fake-plain-fake-57f9db/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-discovery-eval-ts-discovery-add-social-login-and-email-ea6ace/fake-plain-fake-57f9db/1/snapshots/final)

</details>

### ✗ evals/options.eval.ts › renamed options › writes greet.js

**assertion**

```
expected file greet.js to exist
```

- Prompt (completed, 1ms): Write greet.js.
- Time: setup 17ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-options-eval-ts-renamed-options-writes-greet-js-b9f9b0/fake-app-fake-e80a19/1/transcript.jsonl) · [diff](evals-options-eval-ts-renamed-options-writes-greet-js-b9f9b0/fake-app-fake-e80a19/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-options-eval-ts-renamed-options-writes-greet-js-b9f9b0/fake-app-fake-e80a19/1/snapshots/final)
