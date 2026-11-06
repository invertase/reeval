#!/usr/bin/env bash
# Records the real-agent runs found under each folder given (every project's .reeval/runs, with
# its .reeval/debug) into test/real-agents' `ci` history store, R2 in CI. The runs come from
# throwaway projects, so they're gathered into test/real-agents' own .reeval first, then recorded
# there one at a time. `reeval sync --push-only` checks the settings and the store first, without
# pulling the CI history: a missing setting (exit 2) or a store that fails (exit 3) fails the step
# before any run is tried. Then a run reeval refuses to record (exit 2: a secret-scan finding or a
# changed file; an interrupted run is recorded anyway) is a warning, and a store that fails
# (exit 3) fails the step once every run has been tried.
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "$0")/.." && pwd)"
project="$root/packages/reeval/test/real-agents"
cli="$root/packages/reeval/dist/cli.js"
runs="$project/.reeval/runs"
debug="$project/.reeval/debug"
mkdir -p "$runs" "$debug"

(cd "$project" && node "$cli" sync --profile ci --push-only) || exit $?

ids=()
for dir in "$@"; do
  [ -d "$dir" ] || continue
  while IFS= read -r found; do
    for file in "$found"/*.json; do
      id=$(basename "$file" .json)
      [[ $id =~ ^[0-9]{8}T[0-9]{6}Z_ ]] || continue
      if [ "$found" != "$runs" ]; then
        cp "$file" "$runs/"
        [ -d "$found/$id" ] && cp -R "$found/$id" "$runs/"
        [ -d "$found/../debug/$id" ] && cp -R "$found/../debug/$id" "$debug/"
      fi
      ids+=("$id")
    done
  done < <(find "$dir" -type d -path '*/.reeval/runs' -prune -print)
done

failed=0
for id in $(printf '%s\n' "${ids[@]}" | sort -u); do
  [ -n "$id" ] || continue
  (cd "$project" && node "$cli" record --profile ci --allow-incomplete "$id")
  case $? in
    0) ;;
    1 | 2) echo "::warning title=reeval: run not recorded::$id wasn't recorded to the CI history (see the log above)" ;;
    *) failed=1 ;;
  esac
done
echo "${#ids[@]} run(s) found under $*"
exit $((failed ? 3 : 0))
