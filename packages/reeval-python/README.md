# reeval-python

Python authoring SDK for [reeval](https://github.com/invertase/reeval). Write `*.eval.py` files,
declare evals with the same options as TypeScript, and run them through reeval's language runner
(over its stdin and stdout, attempt protocol v2).

Import as `reeval_python` (`from reeval_python import evaluate`). The PyPI distribution is
**reeval-python** (the name `reeval` is already taken on PyPI by another project).

With reeval installed, default discovery includes `evals/**/*.eval.py`. When your project has
`pyproject.toml` or `uv.lock` and [uv](https://docs.astral.sh/uv/) is on `PATH`, reeval starts the
runner with `uv run --project <root> python -m reeval_python`. Otherwise it uses `<root>/.venv/bin/python`
when present, then `python3`. Set `REEVAL_PYTHON` to override the interpreter.

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
from reeval_python import evaluate, expect


@evaluate("lands")
def lands(c):
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
`to_pass`, `to_equal`, `to_contain`, …). Matcher failures raise `ReevalAssertionError`. Async bodies use
`async def`, `await c.send(...)`, and `await expect(await c.exec(...)).to_succeed()`; sync bodies
use plain `def` and block on the runner loop.

## Examples

- Feature smoke: `packages/reeval/test/features/python-sdk/hello/` (uv project with a project dependency)
- Plan case: `packages/reeval/test/plan/python/`
- Contributor guide: `.agents/skills/add-a-language/SKILL.md` in the reeval repo
