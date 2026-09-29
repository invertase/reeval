#!/usr/bin/env bash
# The nightly real-agent smoke: the real-tier feature fixtures, then examples/hello's smoke
# profile. Needs CURSOR_API_KEY, Docker and reeval's image (reeval image build); the example also needs
# GOOGLE_GENERATIVE_AI_API_KEY, for its judge and its Gemini eval. Asked for, it never skips: a
# missing key fails it, naming the variable.
set -euo pipefail
cd "$(dirname "$0")/.."
missing=()
for name in CURSOR_API_KEY GOOGLE_GENERATIVE_AI_API_KEY; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
for name in "${missing[@]}"; do echo "real smoke failed: $name isn't set" >&2; done
[ ${#missing[@]} -eq 0 ] || exit 1
pnpm build
pnpm --filter reeval test:real
# The built CLI, not the reeval bin: pnpm links a bin only if it existed at install time.
cd examples/hello
node ../../packages/reeval/dist/cli.js run --profile smoke
