# reeval run 20261020T230148Z_958e309_cursor-agent_qghb

4 fail · 4 pass · started 2026-10-20T23:01:48.950Z (944ms)

Plan: 8 evals · 8 cells · 8 attempts

## Results

```text
fail             bills in minor units with the billing doc
  amount in minor units  failed
    expected command to succeed, exit code 1

                 adds a $name button that builds
  pass  reset      1 of 1
  pass  double     1 of 1
  pass  clear      1 of 1

fail             greets in the house style
  house greeting   failed
    expected command to succeed, exit code 1
  +1 more passed

pass             writes greet.js

fail             greets in French
  french greeting  failed
    expected command to succeed, exit code 1

fail             greets in Spanish
  spanish greeting  failed
    expected command to succeed, exit code 1

4 fail · 4 pass
Set analysis.model in reeval.config.ts for answers to what each eval asks.
```

## State

| | |
|---|---|
| Executed at | 958e309150a2 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | with-doc 26d7ac38e3f5 |
| Judge | none by default · threshold 0.8 · version 5ca76dcaadfa |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.8 · @reeval/harness-opencode 0.2.8 · @reeval/harness-goose 0.1.3 · @reeval/harness-pi 0.2.7 · @reeval/harness-cursor-sdk 0.1.5 · @ai-sdk/harness-claude-code 1.0.158-patch.6c1cff12 · @reeval/harness-codex 0.1.7 · @reeval/harness-fx 0.1.0 · @reeval/harness-grok-build 0.1.0 · ai 7.0.143 · @ai-sdk/harness 1.0.154 · @ai-sdk/google 4.0.99 · @ai-sdk/typesafe-ai 3.0.21 |
| reeval | 0.10.0 · node 22.23.3 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261020T230148Z_958e309_cursor-agent_qghb.json](../20261020T230148Z_958e309_cursor-agent_qghb.json) · artifacts: all

## Attempts

### ✗ evals/billing.eval.ts › bills in minor units with the billing doc

**assertion**

```
amount in minor units: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 1ms): Bill the customer 12.50 GBP.
- Time: setup 34ms · agent 1ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check amount in minor units exit 1: `grep -q pence docs/billing.md` ([log](evals-billing-eval-ts-bills-in-minor-units-with-the-billing-a15c29/fake-with-doc-fake-ff0b8e/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-billing-eval-ts-bills-in-minor-units-with-the-billing-a15c29/fake-with-doc-fake-ff0b8e/1/transcript.jsonl) · [diff](evals-billing-eval-ts-bills-in-minor-units-with-the-billing-a15c29/fake-with-doc-fake-ff0b8e/1/diff.patch)

### ✗ evals/greet.eval.ts › greets in the house style

**assertion**

```
house greeting: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 2ms): Write greet.js that greets in our house style.
- Time: setup 19ms · agent 2ms · checks 4ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check house greeting exit 1: `grep -q Ahoy greet.js` ([log](evals-greet-eval-ts-greets-in-the-house-style-bf5705/fake-fake-70e87d/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-greets-in-the-house-style-bf5705/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-ts-greets-in-the-house-style-bf5705/fake-fake-70e87d/1/diff.patch)

### ✗ evals/greet.eval.ts › greets in French

**assertion**

```
french greeting: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 5ms): Write greet.js that greets in French.
- Time: setup 17ms · agent 6ms · checks 4ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check french greeting exit 1: `grep -q Bonjour greet.js` ([log](evals-greet-eval-ts-greets-in-french-deb563/fake-fake-70e87d/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-greets-in-french-deb563/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-ts-greets-in-french-deb563/fake-fake-70e87d/1/diff.patch)

### ✗ evals/greet.eval.ts › greets in Spanish

**assertion**

```
spanish greeting: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 6ms): Write greet.js that greets in Spanish.
- Time: setup 17ms · agent 6ms · checks 3ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check spanish greeting exit 1: `grep -q Hola greet.js` ([log](evals-greet-eval-ts-greets-in-spanish-c6706f/fake-fake-70e87d/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-greets-in-spanish-c6706f/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-ts-greets-in-spanish-c6706f/fake-fake-70e87d/1/diff.patch)

### ✓ evals/buttons.eval.ts › adds a reset button that builds

- Prompt (completed, 5ms): Add a reset button.
- Time: setup 22ms · agent 6ms · checks 24ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check build exit 0: `true` ([log](evals-buttons-eval-ts-adds-a-reset-button-that-builds-be7407/fake-fake-70e87d/1/checks/1.log))
- Check types exit 0: `true` ([log](evals-buttons-eval-ts-adds-a-reset-button-that-builds-be7407/fake-fake-70e87d/1/checks/2.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-buttons-eval-ts-adds-a-reset-button-that-builds-be7407/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-buttons-eval-ts-adds-a-reset-button-that-builds-be7407/fake-fake-70e87d/1/diff.patch)

### ✓ evals/buttons.eval.ts › adds a double button that builds

- Prompt (completed, 5ms): Add a double button.
- Time: setup 16ms · agent 5ms · checks 10ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check build exit 0: `true` ([log](evals-buttons-eval-ts-adds-a-double-button-that-builds-ff2bf6/fake-fake-70e87d/1/checks/1.log))
- Check types exit 0: `true` ([log](evals-buttons-eval-ts-adds-a-double-button-that-builds-ff2bf6/fake-fake-70e87d/1/checks/2.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-buttons-eval-ts-adds-a-double-button-that-builds-ff2bf6/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-buttons-eval-ts-adds-a-double-button-that-builds-ff2bf6/fake-fake-70e87d/1/diff.patch)

### ✓ evals/buttons.eval.ts › adds a clear button that builds

- Prompt (completed, 6ms): Add a clear button.
- Time: setup 20ms · agent 6ms · checks 14ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check build exit 0: `true` ([log](evals-buttons-eval-ts-adds-a-clear-button-that-builds-9c8b8b/fake-fake-70e87d/1/checks/1.log))
- Check types exit 0: `true` ([log](evals-buttons-eval-ts-adds-a-clear-button-that-builds-9c8b8b/fake-fake-70e87d/1/checks/2.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-buttons-eval-ts-adds-a-clear-button-that-builds-9c8b8b/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-buttons-eval-ts-adds-a-clear-button-that-builds-9c8b8b/fake-fake-70e87d/1/diff.patch)

### ✓ evals/greet.eval.ts › writes greet.js

- Prompt (completed, 5ms): Write greet.js.
- Time: setup 16ms · agent 5ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-70e87d/1/diff.patch)
