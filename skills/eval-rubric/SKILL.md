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

Concern. A variant's difference from its baseline doesn't hold (its 95% interval spans 0), or it
rests on a small sample, in any direction: a side has fewer than 4 counted tries, or a `same`'s
interval still reaches past 20 points (2 of 4 against 2 of 4), so the effect is only a direction;
a family's is its pooled lift's, insufficient below 6 cases. It also prints when both arms pass
every run and no other measure (effort, a judge, a check, a compare question) is better or worse,
but some lean: a difference its own test doesn't hold yet, at p below 0.1 and at least 10
points, 0.05 of a judge's score, 60/40 of 4 or more decisive pairs for a question (p below 0.2), or 10% of an
effort median ("the variant looks different: 10% faster; about 30 runs a side would confirm
it"); weaker ones are the same. **Fix:** raise `runs` to the number the remark
names, or add cases to a family.

## `cant-tell-apart`

Concern. A variant and its baseline both passed every run, or both failed every run, on 4 runs a
side or more (for a family, every case on both sides, over 6 cases or more), so no number of runs
can tell them apart. On a pass ceiling it prints only when every other measure of the comparison
is the same too; one that is better or worse is the result and raises nothing, and one that only
leans raises `too-few-tries`. Both failing always raises it. **Fix:** when both
always pass, make the task harder, so the baseline can fail; when both always fail, check the eval
with an agent that does the task (an oracle, such as a fake agent writing the solution), and make
the task easier if its checks pass.

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
neither refused nor failed to resolve anything, so the connection never reached it: a raw TCP or UDP client, SSH, a database
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

## `snapshot-too-large`

Concern. An attempt's workspace was over its `snapshot` form's cap (as a directory, 50 MB of
files; with `snapshot: { compress: true }`, 10 MB compressed or 200 MB uncompressed; either way
without `node_modules/`, `.git/`, `.cache/` and the other dependency and cache directories), so
reeval took no snapshot of it. The attempt's `snapshots[].skipped` gives the size and the
directories left out. It's about what happened in the run, so it prints in every run it happens.
**Fix:** have the task write generated files (build output, downloads, datasets) into a directory
reeval leaves out, compress the snapshots for the larger cap, or set `snapshot: false` on the eval
when nobody reads its workspace.
