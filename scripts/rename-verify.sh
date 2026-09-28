#!/usr/bin/env bash
# The checks a rename must pass, one log per step: install, build, lint, typecheck, schema
# check, every package's tests, the docs check and the engine differential (re-recorded, then
# compared with test/differential/vitest). Prints each step's exit code and seconds.
#
#   bash scripts/rename-verify.sh [log-dir]
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
pkg=packages/reeval
[ -d "$pkg" ] || pkg=packages/evalsuite
log=${1:-$root/.rename-verify}
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
step test pnpm -r --no-bail --filter './packages/*' test
step docs pnpm run docs:check
step differential node --experimental-strip-types --no-warnings scripts/differential.mjs record "$log/differential"
step compare node --experimental-strip-types --no-warnings scripts/differential.mjs compare "$pkg/test/differential/vitest" "$log/differential"

printf '%-14s %s in %ss (logs: %s)\n' total "$([ $failed = 0 ] && echo passed || echo FAILED)" "$(($(date +%s) - start))" "$log"
exit $failed
