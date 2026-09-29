# reeval run 20260929T223835Z_08a5026_cursor-agent_96q4

1 passed · started 2026-09-29T22:38:35.799Z (15s)

Plan: profile cursor (--profile) · 1 evals · 1 cells · 1 attempts

## State

| | |
|---|---|
| Executed at | 08a5026f1d02 on ehesp/experiment-dart-evals-r2-ca15, dirty (the commit that adds this record is later) |
| Uncommitted | worktree.patch, 87744 bytes, sha256 e89f1497e11a |
| Lockfiles | pubspec.lock ab6935ea2be8, ../../pnpm-lock.yaml a01135b30fcd |
| Images | reeval-sandbox:cursor-0.1.0-dart-stable-038975bd · id 1e36d8abcc20 · no registry digest (built locally) · CLI @cursor/sdk 1.0.32 |
| Harnesses | cursor:composer-2.5 (model composer-2.5, served composer-2.5[fast=true]) |
| Environments | none |
| Judge | fake (served gemini-3.8-flash) · threshold 0.8 · version 5f5bd2b4c5f3 |
| Context | 1 file: ~/.agents/skills/.ai-sdk-harness-skills.json 5ddf48ce4d70 |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.2.0 · node 26.3.0 · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.0-dart-stable-038975bd isn't pushed, so an exact rerun needs this machine's image (id 1e36d8abcc20).

Record: [20260929T223835Z_08a5026_cursor-agent_96q4.json](../20260929T223835Z_08a5026_cursor-agent_96q4.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/greet_eval.dart › greet library › writes a greet function | 13s | pass 1.00/0.8 |

### ✓ evals/greet_eval.dart › greet library › writes a greet function

- Prompt (completed, 9s): Create lib/greet.dart exporting String greet(String name) that returns "Hello, <name>!", and bin/main.dart that prints greet() of its first argument, or of "Dart" without one. Import lib/greet.dart…
- Time: setup 2s · agent 9s · checks 231ms · judge 2s
- Agent: 3 file edits · 2 other tool calls · 0 web searches · 0 fetches · 226ms reasoning
- Judge **pass** 1.00 (threshold 0.8, google/gemini-3.8-flash): Does the final message describe the files it created?
- Check exit 0: `dart bin/main.dart` ([log](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/cursor-composer-2-5-docker-dart-stable-460ee2/1/checks/1.log))
- Changed: added `bin/main.dart`, added `lib/greet.dart`, added `pubspec.yaml`

Last message:

> Checking the workspace for an existing Dart project structure.
> 
> 
> Creating a minimal Dart package with `lib/greet.dart` and `bin/main.dart`.
> 
> 
> Here’s what was added:
> 
> **`lib/greet.dart`** — top-level `greet` (usable as a library export):
> 
> ```dart
> String greet(String name) => 'Hello, $name!';
> ```
> 
> **`bin/main.dart`** — relative import and default name `"Dart"`:
> 
> ```dart
> import '../lib/greet.dart';
> 
> void main(List<String> arguments) {
>   final name = arguments.isEmpty ? 'Dart' : arguments.first;
>   print(greet(name));
> }
> ```
> 
> **`pubspec.yaml`** — package metadata only; no `dependencies`.
> 
> Run:
> 
> ```bash
> dart run bin/main.dart          # Hello, Dart!
> dart run bin/main.dart Alice    # Hello, Alice!
> ```
> 
> `dart` isn’t available in this environment, so those commands weren’t run here.

- Files: [transcript](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/cursor-composer-2-5-docker-dart-stable-460ee2/1/transcript.jsonl) · [diff](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/cursor-composer-2-5-docker-dart-stable-460ee2/1/diff.patch) · [judge input](evals-greet-eval-dart-greet-library-writes-a-greet-function-e7e3eb/cursor-composer-2-5-docker-dart-stable-460ee2/1/judge-input.json)
