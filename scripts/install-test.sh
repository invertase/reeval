#!/bin/sh
# Tests scripts/install.sh against fake releases in a temporary directory: what it installs, what
# it refuses, and every byte-prefix of it piped to sh, as a dropped `curl | sh` would run it.
#
#   sh scripts/install-test.sh
set -u

script=$(cd "$(dirname "$0")" && pwd)/install.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
V=0.0.1
failures=0
pass() { echo "ok   $1"; }
fail() {
  echo "FAIL $1"
  failures=$((failures + 1))
}

# release <dir> <binary body>: every target's binary, all with that body, and their SHA256SUMS.
release() {
  mkdir -p "$1"
  for target in linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl darwin-x64 darwin-arm64; do
    printf '#!/bin/sh\n%s\n' "$2" > "$1/reeval-$V-$target"
  done
  (cd "$1" && if command -v sha256sum >/dev/null; then sha256sum reeval-*; else shasum -a 256 reeval-*; fi > SHA256SUMS)
}
# install <release dir> <install dir> [script]: runs the script quietly; its exit code.
install() {
  REEVAL_VERSION=$V REEVAL_DOWNLOAD="file://$1" REEVAL_INSTALL_DIR="$2" sh "${3:-$script}" > "$work/out" 2>&1
}

release "$work/good" "echo $V"
if install "$work/good" "$work/a" && [ "$("$work/a/reeval" --version)" = $V ]; then pass "installs the release's binary"
else fail "installs the release's binary: $(cat "$work/out")"; fi

cp -R "$work/good" "$work/tampered"
for f in "$work"/tampered/reeval-*; do echo tampered >> "$f"; done
if ! install "$work/tampered" "$work/b" && [ ! -e "$work/b/reeval" ] && grep -q "doesn't match SHA256SUMS" "$work/out"; then
  pass "refuses a binary that doesn't match SHA256SUMS"
else fail "refuses a binary that doesn't match SHA256SUMS: $(cat "$work/out")"; fi

cp -R "$work/good" "$work/unlisted"
: > "$work/unlisted/SHA256SUMS"
if ! install "$work/unlisted" "$work/c" && [ ! -e "$work/c/reeval" ]; then pass "refuses a binary SHA256SUMS doesn't list"
else fail "refuses a binary SHA256SUMS doesn't list: $(cat "$work/out")"; fi

# Past the shebang line and before main's closing brace, a prefix must fail or install.
size=$(wc -c < "$script" | tr -d ' ')
first=$(head -n 1 "$script" | wc -c | tr -d ' ')
last=$(($(grep -n '^}$' "$script" | tail -n 1 | cut -d : -f 1) - 1))
last=$(head -n "$last" "$script" | wc -c | tr -d ' ')
silent=
n=$((first + 1))
while [ "$n" -le "$last" ]; do
  head -c "$n" "$script" > "$work/prefix.sh"
  if install "$work/good" "$work/p$n" "$work/prefix.sh" && [ ! -x "$work/p$n/reeval" ]; then silent="$silent $n"; fi
  n=$((n + 1))
done
if [ -z "$silent" ]; then pass "every prefix of the $size bytes ($first..$last) fails or installs"
else fail "these prefixes exit 0 having installed nothing:$silent"; fi

[ "$failures" = 0 ] || exit 1
