# reeval run 20260929T215641Z_2e1894e_cursor-agent_k6ev

3 passed · 1 skipped · started 2026-09-29T21:56:41.444Z (774ms)

Plan: 3 evals · 3 cells · 3 attempts

## State

| | |
|---|---|
| Executed at | 2e1894e26720 on ehesp/experiment-dart-evals-ca15, dirty (the commit that adds this record is later) |
| Uncommitted | worktree.patch, 9298 bytes, sha256 3f624b99da34 |
| Lockfiles | pubspec.lock ab6935ea2be8, ../../pnpm-lock.yaml a01135b30fcd |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | none |
| Judge | fake · threshold 0.8 · version 5f5bd2b4c5f3 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.2.0 · node 26.3.0 · linux/x64 |
| Runner | local · cursor-agent |

Record: [20260929T215641Z_2e1894e_cursor-agent_k6ev.json](../20260929T215641Z_2e1894e_cursor-agent_k6ev.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/greet_eval.dart › greet library › writes a greet function | 288ms | pass 0.92/0.8 |
| ✓ | evals/greet_eval.dart › greet library › greets Ada | 293ms |  |
| ✓ | evals/greet_eval.dart › greet library › greets Grace | 279ms |  |
| ↓ | evals/greet_eval.dart › handles names with emoji | todo |  |

### ✓ evals/greet_eval.dart › greet library › writes a greet function

- Prompt (completed, 2ms): Create lib/greet.dart exporting String greet(String name) that returns "Hello, <name>!", and bin/main.dart that prints greet() of its first argument, or of "Dart" without one. Import lib/greet.dart…
- Time: setup 15ms · agent 3ms · checks 247ms · judge 1ms
- Agent: 2 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.92 (threshold 0.8, fake): Does the final message describe the files it created?
- Check exit 0: `dart bin/main.dart` ([log](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/fake-fake-70e87d/1/checks/1.log))
- Changed: added `bin/main.dart`, added `lib/greet.dart`

Last message:

> I created lib/greet.dart with greet(name), and bin/main.dart, which prints it.

- Files: [transcript](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/fake-fake-70e87d/1/diff.patch) · [judge input](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/fake-fake-70e87d/1/judge-input.json)

### ✓ evals/greet_eval.dart › greet library › greets Ada

- Prompt (completed, 0ms): Create lib/greet.dart exporting String greet(String name) that returns "Hello, <name>!", and bin/main.dart that prints greet() of its first argument, or of "Dart" without one. Import lib/greet.dart…
- Time: setup 14ms · agent 1ms · checks 262ms · judge 0ms
- Agent: 2 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `dart bin/main.dart Ada` ([log](evals-greet-eval-dart-greet-library-greets-ada-a10b99/fake-fake-70e87d/1/checks/1.log))
- Changed: added `bin/main.dart`, added `lib/greet.dart`

Last message:

> I created lib/greet.dart with greet(name), and bin/main.dart, which prints it.

- Files: [transcript](evals-greet-eval-dart-greet-library-greets-ada-a10b99/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-dart-greet-library-greets-ada-a10b99/fake-fake-70e87d/1/diff.patch)

### ✓ evals/greet_eval.dart › greet library › greets Grace

- Prompt (completed, 2ms): Create lib/greet.dart exporting String greet(String name) that returns "Hello, <name>!", and bin/main.dart that prints greet() of its first argument, or of "Dart" without one. Import lib/greet.dart…
- Time: setup 13ms · agent 2ms · checks 244ms · judge 0ms
- Agent: 2 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `dart bin/main.dart Grace` ([log](evals-greet-eval-dart-greet-library-greets-grace-1447d4/fake-fake-70e87d/1/checks/1.log))
- Changed: added `bin/main.dart`, added `lib/greet.dart`

Last message:

> I created lib/greet.dart with greet(name), and bin/main.dart, which prints it.

- Files: [transcript](evals-greet-eval-dart-greet-library-greets-grace-1447d4/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-dart-greet-library-greets-grace-1447d4/fake-fake-70e87d/1/diff.patch)
