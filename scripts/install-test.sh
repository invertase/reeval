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
  for target in linux-x64 linux-x64-baseline linux-arm64 linux-x64-musl linux-x64-musl-baseline \
    linux-arm64-musl darwin-x64 darwin-arm64; do
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

release "$work/sigill" 'kill -ILL $$'
if ! install "$work/sigill" "$work/h" && [ ! -e "$work/h/reeval" ] && grep -q "doesn't start on this machine (exit 132)" "$work/out"; then
  pass "refuses a binary that dies on start (no AVX2)"
else fail "refuses a binary that dies on start (no AVX2): $(cat "$work/out")"; fi

release "$work/nolib" 'echo "Error loading shared library libstdc++.so.6" >&2; exit 127'
if ! install "$work/nolib" "$work/i" && [ ! -e "$work/i/reeval" ] && grep -q "exit 127), so nothing was installed: Error loading shared library" "$work/out"; then
  pass "refuses a binary that can't load, with its error"
else fail "refuses a binary that can't load, with its error: $(cat "$work/out")"; fi

# The newest release with SHA256SUMS, from the GitHub API, which this curl answers from a fixture:
# a newer release still without binaries, a prerelease, a draft and another component's release.
mkdir -p "$work/bin"
cat > "$work/releases.json" <<JSON
[
  {
    "tag_name": "v0.0.9", "name": "v0.0.9", "draft": false, "prerelease": false,
    "assets": [], "body": "Notes with \\"tag_name\\": \\"v9.9.9\\" in them"
  },
  {
    "tag_name": "v0.0.8", "draft": false, "prerelease": true,
    "assets": [{ "name": "SHA256SUMS" }]
  },
  { "tag_name": "v0.0.7", "draft": true, "prerelease": false, "assets": [{ "name": "SHA256SUMS" }] },
  {
    "tag_name": "reeval-python-v0.0.6", "draft": false, "prerelease": false,
    "assets": [{ "name": "SHA256SUMS" }]
  },
  {
    "tag_name": "v$V", "draft": false, "prerelease": false,
    "assets": [{ "name": "reeval-$V-linux-x64", "uploader": { "login": "x" } }, { "name": "SHA256SUMS" }]
  },
  { "tag_name": "v0.0.0", "draft": false, "prerelease": false, "assets": [{ "name": "SHA256SUMS" }] }
]
JSON
real_curl=$(command -v curl)
cat > "$work/bin/curl" <<SH
#!/bin/sh
header=
case " \$* " in *" -H @- "*) header=\$(cat) ;; esac
echo "\$* \$header" >> "$work/curl.log"
for url; do :; done
case \$url in
  https://api.github.com/*)
    status=200
    case \$header in *"\${REFUSED:-none}"*) status=401 ;; esac
    [ -n "\${API_STATUS:-}" ] && status=\$API_STATUS
    [ "\$status" = 200 ] && cat "\$RELEASES"
    printf '\n%s' "\$status" ;;
  https://github.com/invertase/reeval/releases/download/v*)
    set -- "\$@"; n=\$#; i=0
    for a; do i=\$((i + 1)); [ \$i -lt \$n ] && set -- "\$@" "\$a"; done
    shift "\$n"
    exec "$real_curl" "\$@" "file://$work/good/\${url##*/}" ;;
  *) exec "$real_curl" "\$@" ;;
esac
SH
chmod +x "$work/bin/curl"
latest() { # latest <releases file> <install dir> [VAR=value…]: installs with no REEVAL_VERSION
  file=$1 dir=$2
  shift 2
  env PATH="$work/bin:$PATH" RELEASES="$file" REEVAL_INSTALL_DIR="$dir" "$@" sh "$script" > "$work/out" 2>&1
}
if latest "$work/releases.json" "$work/d" && [ "$("$work/d/reeval" --version)" = $V ]; then
  pass "installs the newest published release that has SHA256SUMS"
else fail "installs the newest published release that has SHA256SUMS: $(cat "$work/out")"; fi
tr -d '\n' < "$work/releases.json" > "$work/one-line.json"
if latest "$work/one-line.json" "$work/e" && [ "$("$work/e/reeval" --version)" = $V ]; then
  pass "reads the release list on one line too"
else fail "reads the release list on one line too: $(cat "$work/out")"; fi
echo '[{ "tag_name": "v0.0.9", "draft": false, "prerelease": false, "assets": [] }]' > "$work/none.json"
if ! latest "$work/none.json" "$work/f" && grep -q "has binaries yet" "$work/out"; then
  pass "says when no release has binaries yet"
else fail "says when no release has binaries yet: $(cat "$work/out")"; fi
: > "$work/curl.log"
latest "$work/releases.json" "$work/g" GITHUB_TOKEN=secret-token
if grep -q 'api.github.com/.* Authorization: Bearer secret-token$' "$work/curl.log"; then
  pass "sends GITHUB_TOKEN to the GitHub API, on curl's stdin"
else fail "sends GITHUB_TOKEN to the GitHub API, on curl's stdin: $(cat "$work/curl.log")"; fi
if grep -v api.github.com "$work/curl.log" | grep -q secret-token; then fail "sends GITHUB_TOKEN only to the API"
else pass "sends GITHUB_TOKEN only to the API"; fi
if latest "$work/releases.json" "$work/h" GITHUB_TOKEN=stale-token REFUSED=stale-token &&
  [ "$("$work/h/reeval" --version)" = $V ] && grep -q "refused GITHUB_TOKEN" "$work/out"; then
  pass "lists the releases without a GITHUB_TOKEN the API refuses"
else fail "lists the releases without a GITHUB_TOKEN the API refuses: $(cat "$work/out")"; fi
if ! latest "$work/releases.json" "$work/i" API_STATUS=403 && grep -q "rate-limited" "$work/out"; then
  pass "says when the API rate-limits it"
else fail "says when the API rate-limits it: $(cat "$work/out")"; fi
if ! latest "$work/releases.json" "$work/j" API_STATUS=500 && grep -q "HTTP 500" "$work/out" &&
  ! grep -q "rate-limited" "$work/out"; then
  pass "names the API's status on any other failure"
else fail "names the API's status on any other failure: $(cat "$work/out")"; fi

# Past the shebang line, a prefix must fail or install.
size=$(wc -c < "$script" | tr -d ' ')
first=$(head -n 1 "$script" | wc -c | tr -d ' ')
last=$size
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
