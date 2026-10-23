---
name: eval-rubric
description: The rubric reeval holds evals to, one section per remark kind. Load it when writing or reviewing a reeval eval's name, prompts, judge questions or compare, or when a reeval run prints a Remarks block. It's also the rubric reeval's analysis model applies when it raises remarks.
---

# The eval rubric

A remark is about the eval, not the agent: something in the eval's source that stops it answering
its own question, with the edit that fixes it. reeval prints remarks under the tally of
`reeval run`, at most three concerns; suggestions print under `-v`.

**Zero remarks is the expected answer.** A well-written eval raises none. Raise a remark only when
this run shows the problem mattered, never for style, taste or a problem that might matter some day.

## Gates

reeval's analysis model may raise only the six model kinds below. reeval checks every one in code
and drops, without asking again, a remark that:

- has any other kind;
- has no `source`: the `L<n>` of a line in the eval's source and a quote copied exactly from that
  line (the file must be unchanged since the run).

The text is one plain sentence of at most 25 words saying what's wrong. One remark of a kind per
eval. Give the evidence from this run (fact ids or attempt transcript lines) and a `fix`: the
`L<n>` of the line to change and a concrete edit ("ask 'Is Genkit the first framework the reply
recommends?'"), not advice ("consider clarifying the question"). The rest of the kinds are
reeval's own rules, from hard thresholds: the model never raises them.

## `name-contradicts`

Model, concern. The eval's name says it asks one thing, and its checks and judge questions look at
another. The name is the eval's statement of intent, so a reader trusts a result for a question
the eval never asked.

- **Raise it when** the classification read the name as `contradicts` and a check or judge
  question in this run looks at a different subject: the name says Genkit and no check or judge
  mentions Genkit.
- **Evidence:** the checks or judge results whose subject differs from the name.
- **Quote:** the name, on its `evaluate` line. **Fix:** rename the eval to what it checks, or
  check what the name says.
- **Not when** the name and checks use different words for the same thing.

## `name-no-intent`

Model, suggestion. The name is a topic, a ticket id or "test 3", so it doesn't say what the eval
asks.

- **Raise it when** the classification read the name as `no-intent`.
- **Evidence:** the eval's own fact.
- **Quote:** the name. **Fix:** a name that states the question the checks answer, as a reader
  could check it against the result: `bills in minor units with the acme-billing skill`, not
  `billing`.

## `judge-too-loose`

Model, concern. A judge question accepts replies that don't answer the eval's question, so it
passes the wrong behaviour.

- **Raise it when** a judge passed in this run on a reply that doesn't do what the eval's name
  asks: "Pass if Genkit is mentioned as a viable solution" passed a reply that recommends Pydantic
  AI and lists Genkit fifth.
- **Evidence:** the passed judge check, and the attempt's line or final message showing the reply
  didn't answer the question.
- **Quote:** the judge question. **Fix:** a stricter question that fails that reply: "Is Genkit
  the framework the reply recommends first?"
- **Not when** the judge passed replies that do answer the question.

## `judge-leaks-answer`

Model, concern. The judge question gives away the answer, so a reply that only echoes its wording
passes.

- **Raise it when** a judge passed a reply that only repeats the question's words, and another
  check on that attempt failed.
- **Evidence:** the passed judge check and the failed check on the same attempt.
- **Quote:** the judge question. **Fix:** a question about the result, not its wording: ask
  whether the tests pass, not whether the reply says "tests pass".

## `prompt-names-tool`

Model, concern. A choose eval asks which tool the agent picks, but its prompt names the tool, so
the agent is told the answer.

- **Raise it when** the eval's job is `choose`, its prompt contains the tool it asks about, and
  this run's replies named that tool.
- **Evidence:** the attempts whose replies named the tool.
- **Quote:** the tool's name on the prompt's line. **Fix:** the prompt without the tool's name,
  describing the task instead.

## `compound-judge`

Model, suggestion. One judge question asks two things, so a reply that meets one part fails, and
the result can't say which part it missed.

- **Raise it when** a judge question with two parts ("uses Zod and adds tests") failed in this run
  on a reply that meets one part.
- **Evidence:** the failed judge check, and the attempt's line meeting one part.
- **Quote:** the judge question. **Fix:** two judge questions, one per part.

## `too-few-tries`

reeval's rule, suggestion. A variant and its baseline differ by at least 50 points with fewer than
4 counted tries a side, so the effect reads "can't tell yet" on a gap that matters. **Fix:** raise
`runs` to 4 or more.

## `check-never-fails`

reeval's rule, suggestion. A check passed every try over at least 5 recorded runs on the default
branch and 20 tries on the same setup (on a compare, on both sides every run), so it never tells a
good result from a bad one. **Fix:** make it strict enough to fail on a wrong result, or remove it.

## `flaky-check`

reeval's rule, concern. A cell is flaky over comparable runs (at least 6 counted tries), and the
check both passed and failed in at least 2 of its newest 5 runs with nothing changed. **Fix:**
check something every good try does, or raise `runs` so one try doesn't decide it.

## `no-baseline`

reeval's rule on the classification, concern. The eval is about a change (a skill, a doc, an MCP
server: the classification's `subject.change`) but declares no `compare`, so nothing shows what the
change does. A profile's `limit.compare: false` is deliberate and never raises it. **Fix:** add
`compare` with a baseline without the change.

## `slow-mcp-start`

reeval's rule, concern. A stdio MCP server took 2 seconds or more to answer `initialize`, or never
answered. It's about the environment, not the eval's source, so it prints in every run it happens.
**Fix:** install what the server needs in the image, so it doesn't fetch or build it at start-up.

## `proxy-only-egress`

reeval's rule, concern. An attempt under egress `'proxy'` (the default) failed with a connection
error (`Network is unreachable`, `ECONNREFUSED`, `Could not resolve host`, …) and the egress gateway
refused nothing, so the connection never reached it: a raw TCP or UDP client, SSH, a database
driver, or a client that ignores `HTTPS_PROXY`. It's about what happened in the run, so it prints in
every run it happens. **Fix:** set `egress: 'allow-all'` on the eval if it needs raw TCP or UDP, or
point the client at `HTTPS_PROXY`.
