#!/usr/bin/env bash
# The nightly real-agent smoke: the real-tier feature fixtures, then test/real-agents' smoke
# profile. Needs CURSOR_API_KEY, Docker and reeval's image (reeval image build); the smoke also needs
# GOOGLE_GENERATIVE_AI_API_KEY, for its Gemini eval. Asked for, it never skips: a
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
cd packages/reeval/test/real-agents
node ../../dist/cli.js run --profile smoke
