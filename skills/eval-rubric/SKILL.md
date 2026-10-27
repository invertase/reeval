---
name: eval-rubric
description: The rubric reeval holds evals to, one section per remark kind. Load it when writing or reviewing a reeval eval's name, prompts, judge questions or compare, or when a reeval run prints a Remarks block.
---

# The eval rubric

A remark is about the eval, not the agent: something that stops it answering its own question,
with the edit that fixes it. reeval raises remarks from fixed thresholds over the run and the
history, and prints them under the tally of `reeval run`: at most three concerns, and suggestions
under `-v`. A well-written eval raises none.

## Before a run

reeval doesn't check these, so read the eval for them yourself:

- **The name states the question** the checks answer (`bills in minor units with the
  acme-billing skill`, not `billing` or `test 3`), and the checks look at what it says.
- **A judge question fails the wrong reply.** "Is Genkit the framework the reply recommends
  first?", not "Is Genkit mentioned?"; ask about the result, not whether the reply uses the
  question's words.
- **One judge question asks one thing.** Split "uses Zod and adds tests" in two.
- **A prompt doesn't name the tool** an eval asks the agent to choose.
- **An eval about a change compares it:** a skill, doc or MCP server gets `compare` with a
  baseline without it.

## `too-few-tries`

Suggestion. A variant and its baseline differ by at least 50 points with fewer than
4 counted tries a side, so the effect reads "can't tell yet" on a gap that matters. **Fix:** raise
`runs` to 4 or more.

## `check-never-fails`

Suggestion. A check passed every try over at least 5 recorded runs on the default
branch and 20 tries on the same setup (on a compare, on both sides every run), so it never tells a
good result from a bad one. **Fix:** make it strict enough to fail on a wrong result, or remove it.

## `flaky-check`

Concern. A cell is flaky over comparable runs (at least 6 counted tries; below that it's
`mixed` and raises nothing), and the check both passed and failed in at least 2 of its newest 5
runs with nothing changed. **Fix:** check something every good try does, or raise `runs` so one
try doesn't decide it.

## `slow-mcp-start`

Concern. A stdio MCP server took 2 seconds or more to answer `initialize`, or never
answered. It's about the environment, not the eval's source, so it prints in every run it happens.
**Fix:** install what the server needs in the image, so it doesn't fetch or build it at start-up.

## `proxy-only-egress`

Concern. An attempt under egress `'proxy'` (the default) failed with a connection
error (`Network is unreachable`, `ECONNREFUSED`, `Could not resolve host`, …) and the egress gateway
refused nothing, so the connection never reached it: a raw TCP or UDP client, SSH, a database
driver, or a client that ignores `HTTPS_PROXY`. It's about what happened in the run, so it prints in
every run it happens. **Fix:** set `egress: 'allow-all'` on the eval if it needs raw TCP or UDP, or
point the client at `HTTPS_PROXY`.

## `setup-process-secret`

Concern. In Docker, a setup step left a process running (`nohup server &`) with a
`to: 'checks'` secret without `hosts` in its environment, so the process holds the real value while
the agent, as the same user, works beside it and can read it. The attempt's `setupProcesses` names
each process and secret. It matches the secret's variable name, so no remark doesn't mean no
process holds the value: a copy under another name or in a command's arguments isn't found. It's
about what happened in the run, so it prints in every run it happens.
**Fix:** broker the secret with the hosts the process sends it to, so it holds a placeholder, or
start the process from `c.exec` after the agent's turn.
