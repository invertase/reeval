# Plan tier stub (Python SDK)

When the engine loads `*.eval.py`, add a plan case here mirroring `plan/selection` (`tags.eval.ts`)
with `reeval run --dry-run` driven by `evals/tags.eval.py`. Until then, declare drift is caught by
`packages/reeval-python` against `test/conformance/declare/tags/expected.json`.
