# Recorded dogfood runs

Commit run records here from **real** harness profiles (`pr`, `nightly`, …), not from fake/smoke tutorial configs.

```bash
# From repo root, with CURSOR_API_KEY and judge keys in .env.local:
pnpm build
pnpm exec reeval image build
pnpm exec reeval run skill-fix-config --profile pr --record
git add evals/.history
```

Redact secrets before commit; trim very large attempt trees if needed (keep `summary.md` and record JSON).
