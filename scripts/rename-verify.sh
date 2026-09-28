#!/usr/bin/env bash
# The checks a rename must pass, one log per step: install, build, lint, typecheck, the schema
# check, the docs check and the engine differential (re-recorded, then compared with
# test/differential/vitest). --full adds every package's tests, which CI also runs. Prints each
# step's exit code and seconds.
#
#   bash scripts/rename-verify.sh [--full] [log-dir]
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
full=0
if [ "${1:-}" = --full ]; then
  full=1
  shift
fi
pkg=packages/reeval
[ -d "$pkg" ] || pkg=packages/evalsuite
log=${1:-$(mktemp -d)}
mkdir -p "$log"
failed=0
start=$(date +%s)

step() {
  local name=$1
  shift
  local s rc
  s=$(date +%s)
  "$@" >"$log/$name.log" 2>&1
  rc=$?
  printf '%-14s exit %-3s %5ss\n' "$name" "$rc" "$(($(date +%s) - s))"
  [ "$rc" = 0 ] || failed=1
}

step install pnpm install --frozen-lockfile
step build pnpm build
step lint pnpm lint
step typecheck pnpm typecheck
step schema pnpm --dir "$pkg" schema:check
# `pnpm run`: a bare `pnpm docs…` can resolve to pnpm's own `docs` command.
step docs pnpm run docs:check
step differential node --experimental-strip-types --no-warnings scripts/differential.mjs record "$log/differential"
step compare node --experimental-strip-types --no-warnings scripts/differential.mjs compare "$pkg/test/differential/vitest" "$log/differential"
[ $full = 1 ] && step test pnpm -r --no-bail --filter './packages/*' test

printf '%-14s %s in %ss (logs: %s)\n' total "$([ $failed = 0 ] && echo passed || echo FAILED)" "$(($(date +%s) - start))" "$log"
exit $failed
