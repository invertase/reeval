# reeval-python

Python authoring SDK for [reeval](https://github.com/invertase/reeval). Write `*.eval.py` files,
declare evals with the same options as TypeScript, and run them through reeval's language runner
(loopback TCP, attempt protocol v2).

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

## Examples

- Feature smoke: `packages/reeval/test/features/python-sdk/hello/` (uv project with a project dependency)
- Plan case: `packages/reeval/test/plan/python/`
- Contributor guide: `.agents/skills/add-a-language/SKILL.md` in the reeval repo
