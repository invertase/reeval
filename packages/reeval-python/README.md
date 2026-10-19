# reeval-python

Python authoring SDK for [reeval](https://github.com/invertase/reeval). Write `*.eval.py` files,
declare evals with the same options as TypeScript, and run them through reeval's language runner
(loopback TCP, attempt protocol v2).

With reeval installed, default discovery includes `evals/**/*.eval.py`. The engine spawns
`python3 -m reeval_py.runner` (override with `REEVAL_PYTHON` and `REEVAL_PYTHON_SDK`; see reeval's
Reference → environment variables).

## Install

```bash
pip install reeval-python
```

Monorepo development:

```bash
cd packages/reeval-python
python3 -m pip install -e '.[dev]'
python3 -m pytest
```

Declare trees are checked against `packages/reeval/test/conformance/declare/` goldens. From the
reeval package, `test/python-sdk.test.ts` runs the same suite when `python3` is on `PATH`.

## Examples

- Feature smoke: `packages/reeval/test/features/python-sdk/hello/`
- Plan case: `packages/reeval/test/plan/python/`
- Contributor guide: `.agents/skills/add-a-language/SKILL.md` in the reeval repo
