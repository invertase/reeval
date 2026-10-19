# reeval-python (spike)

Experimental Python declaration layer for [reeval](https://github.com/invertase/reeval). This
package does **not** load into the Node engine yet; it proves declaration trees against
`packages/reeval/test/conformance/declare/` goldens.

```bash
cd packages/reeval-python
python3 -m pip install -e '.[dev]'
python3 -m pytest
```

See `docs/product/python-sdk-effort.md` in the project Agent store for the full assessment.
