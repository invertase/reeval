#!/usr/bin/env bash
# The nightly real-agent smoke: the real-tier feature fixtures, then examples/hello's smoke
# profile. Skips cleanly without CURSOR_API_KEY; needs Docker and ES's image (es image build).
# The example also needs GOOGLE_GENERATIVE_AI_API_KEY, for its judge and its Gemini eval.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "real smoke skipped: CURSOR_API_KEY isn't set"
  exit 0
fi
pnpm build
pnpm --filter @invertase/foobar test:real
if [ -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]; then
  echo "examples/hello smoke skipped: GOOGLE_GENERATIVE_AI_API_KEY isn't set"
  exit 0
fi
cd examples/hello
pnpm es run --profile smoke
