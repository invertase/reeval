# reeval-python

Python authoring SDK for [reeval](https://github.com/invertase/reeval). Write `*.eval.py` files,
declare evals with the same options as TypeScript, and run them through reeval's language runner
(over its stdin and stdout, runner protocol 3). Use the reeval-python version that matches your
reeval: each says which runner protocol it speaks, and refuses another.

Import as `reeval_python` (`from reeval_python import evaluate`). The PyPI distribution is
**reeval-python** (the name `reeval` is already taken on PyPI by another project).

With reeval installed, default discovery includes `evals/**/*.eval.py`. When your project has
`pyproject.toml` or `uv.lock` and [uv](https://docs.astral.sh/uv/) is on `PATH`, reeval starts the
runner with `uv run --project <root> python -m reeval_python`. Otherwise it uses `<root>/.venv/bin/python`
when present, then `python3` (`python` on Windows). Set `REEVAL_PYTHON` to override the interpreter.
The standalone `reeval` binary works the same way and needs only uv besides; install the
reeval-python release made for your reeval, since a runner on another protocol stops the run.

## Install

```bash
uv add reeval-python
# or: pip install reeval-python
```

Monorepo development:

```bash
cd packages/reeval-python
uv sync --dev
uv run pytest
uv run ruff check .
uv run pyright
```

Declare trees are checked against `packages/reeval/test/conformance/declare/` goldens. From the
reeval package, `test/python-sdk.test.ts` runs the same suite in CI.

## Writing evals

```python
from reeval_python import SyncAttemptContext, evaluate, expect


@evaluate("lands", {"runs": 3, "timeout": 300})
def lands(c: SyncAttemptContext) -> None:
    c.send("Create greet.py that prints hi")
    assert c.exec("test -f greet.py").ok
    expect(c.judge("Does greet.py print hi?")).to_pass()
```

Plain `assert` is first-class, as in pytest: each one in an eval file is a check in the run
record, named by its test as written (`assert c.exec("test -f greet.py").ok` is
`assert c.exec("test -f greet.py").ok`). A pass is recorded when it runs. A failure ends the body,
as in Python, and is recorded with its message and both sides of a comparison as the reason
(`greet.py exists: assert 1 == 2`). An `AssertionError` the body catches isn't a failed check, so
a retry loop can assert; one the escaping error carries (each failure in a `TaskGroup`'s
`ExceptionGroup`, or one an error was raised from or while handling) is. Use typed results (`ExecResult.ok`, `Verdict.passed`, `Turn.text`, …) and `c.file(path)`
for quick checks. Keep `expect` for reeval matchers (`to_have_file`, `to_succeed`, soft checks,
labels) — Playwright-style.

Matchers that take a pattern (`to_have_file`, `to_have_run`, `to_have_searched`, `to_have_fetched`,
`to_have_called_tool`, `to_have_edited`, `to_have_changed`) take a `str` or a compiled `re.Pattern`,
`str` or `bytes`, with any flags. Python matches it with `pattern.search`, so anything `re` accepts
works (lookbehind, `re.VERBOSE`, named groups). The record shows the pattern's `repr`.

```python
import re

expect(c.turns[0]).to_have_run(re.compile(r"^(npm|pnpm) t(est)?$"))
```

Use snake_case on the context (`read_file`, `write_file`, `file`) and on matchers (`to_succeed`,
`to_pass`, `to_equal`, `to_contain`, …). Matcher failures raise `ReevalAssertionError`.

Options are typed (`EvalOptions`, and `JudgeOptions` for `c.judge(…)`), so pyright refuses a
misspelt key such as `runz`. They take reeval's keys in snake_case at any depth (`min_lift`,
`delay_ms`); the keys of `env`, `headers` and the other maps of your own keep their spelling. Every
duration is seconds or a `timedelta`: `{"timeout": 90}`, `docker(start_timeout=timedelta(minutes=2))`,
`expect.poll(…, timeout=10)`. `docker()`, `fake_harness()`, `fake_judge()` and `plugin.*` return
values to pass as options, not data to edit.

### `def` and `async def` bodies

A `def` body gets a blocking context: `c.exec(…)` runs the command and returns its `ExecResult`,
and `c.read_file(…)` returns the contents. Use `expect` from `reeval_python`, whose matchers check
at once.

An `async def` body gets the async context: every `c.*` call is a coroutine, and `expect` comes
from `reeval_python.aio`, whose matchers you await. A call or matcher the body never awaits never
runs, so it fails the attempt, and so does a task the body started and left running when it
returns: await each one (`asyncio.gather`, a `TaskGroup`). Each `expect` refuses to run in the
other kind of body, and a body that `yield`s is refused where it's declared.

Annotate `c` (`SyncAttemptContext` or `AttemptContext`) and pyright checks the body too: a missing
`await`, the wrong context for the kind of body, a generator or a returned value. An unannotated
body is checked only when it runs.

```python
from reeval_python import AttemptContext, evaluate
from reeval_python.aio import expect


@evaluate("lands, async")
async def lands(c: AttemptContext) -> None:
    await c.send("Create greet.py that prints hi")
    await expect(await c.exec("python greet.py")).to_succeed()
```

`expect.poll` retries a matcher until it passes, every `interval` until `timeout` (one second by
default). Hand it a function that returns one `c.read_file(…)` or `c.exec(…)`, and reeval reads or
runs it again on each try; it works the same in both kinds of body. Check the output with the
matcher, not in the function: `lambda: c.exec("cat x").stdout` is refused.

```python
expect.poll(lambda: c.read_file("ready.txt"), timeout=10).to_be("ready\n")
expect.poll(c, "the server wrote its log").to_have_file("server.log")
```

### Names of `evaluate_each` cases

`evaluate_each(cases, name)` names each eval from `name`: `%#` is the case's index, `%s` the case
as `str()` writes it, and `$field` a dict case's field. Each placeholder is filled once, so a value
that contains `$` or `%` stays as it is, and a `$field` the case doesn't have is left as written.
Two evals with one name in a file are refused where they're declared.

```python
@evaluate_each([{"lang": "en"}, {"lang": "fr"}], "greets in $lang (#%#)")
def greets(c: SyncAttemptContext, case: dict[str, str]) -> None: ...
```

## Examples

- Feature smoke: `packages/reeval/test/features/python-sdk/hello/` (uv project with a project dependency)
- Plan case: `packages/reeval/test/plan/python/`
- Contributor guide: `.agents/skills/add-a-language/SKILL.md` in the reeval repo
