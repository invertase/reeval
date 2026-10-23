#!/usr/bin/env bash
# The Go SDK's journey on one compiled reeval: `go get -tool …/cmd/reeval@vV` from a tagged
# commit of this repository, then `go tool reeval run` downloads the binary from a release
# directory, checks it against SHA256SUMS, caches it and runs a project's _eval.go files; then
# again offline from the cache.
#
#   scripts/go-tool-smoke.sh <reeval binary> [version]
#
# github.com/invertase/reeval is a scratch repository (git's insteadOf) holding this checkout's
# sdks/go, tagged sdks/go/v<version>, so it runs before the tag or the release exist.
set -euo pipefail

binary=$(realpath "$1")
version=${2:-$(node -p "require('./packages/reeval/package.json').version")}
repo=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64) target=linux-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  *) echo "go-tool-smoke: no target for $(uname -sm)" >&2; exit 2 ;;
esac
if [ "${target%%-*}" = linux ] && { [ -e /etc/alpine-release ] || compgen -G '/lib/ld-musl-*' >/dev/null; }; then
  target=$target-musl
fi

mkdir -p "$work/reeval/sdks"
cp -R "$repo/sdks/go" "$work/reeval/sdks/go"
git -C "$work/reeval" init -q
git -C "$work/reeval" add -A
git -C "$work/reeval" -c user.name=smoke -c user.email=smoke@example.com commit -qm smoke
git -C "$work/reeval" tag "sdks/go/v$version"
git clone -q --bare "$work/reeval" "$work/reeval.git"

asset=reeval-$version-$target
mkdir "$work/release"
cp "$binary" "$work/release/$asset"
(cd "$work/release" && if command -v sha256sum >/dev/null; then sha256sum "$asset"; else shasum -a 256 "$asset"; fi > SHA256SUMS)

cat > "$work/gitconfig" <<EOF
[url "file://$work/reeval.git"]
	insteadOf = https://github.com/invertase/reeval
EOF
export GIT_CONFIG_GLOBAL=$work/gitconfig GOPROXY=direct GOFLAGS=-modcacherw
export GOPRIVATE=github.com/invertase/reeval GOMODCACHE=$work/gomod GOCACHE=$work/gocache
export XDG_CACHE_HOME=$work/cache REEVAL_DOWNLOAD=file://$work/release
unset REEVAL_BINARY REEVAL_VERSION REEVAL_OFFLINE

mkdir -p "$work/project/evals"
cd "$work/project"
go mod init example.com/smoke >/dev/null 2>&1
go get -tool "github.com/invertase/reeval/sdks/go/cmd/reeval@v$version"
grep -q "^tool github.com/invertase/reeval/sdks/go/cmd/reeval$" go.mod

cat > reeval.yml <<'EOF'
harness:
  kind: fake
  script: [[{ write: { greet.go: "package main\n" } }, { reply: Created greet.go. }]]
sandbox: { kind: fake }
EOF
cat > evals/greet_eval.go <<'EOF'
package evals

import (
	"context"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func EvalGreet(e *reeval.E) {
	e.Run("writes greet.go", func(ctx context.Context, c *reeval.C) error {
		if _, err := c.Send(ctx, "Write greet.go in package main."); err != nil {
			return err
		}
		found, err := c.Exec(ctx, `grep -qx "package main" greet.go`)
		if err != nil {
			return err
		}
		c.Assert(found.OK())
		return nil
	})
}
EOF

go tool reeval run 2> "$work/stderr" | tee "$work/stdout"
grep -q "^reeval: downloading $asset$" "$work/stderr" || { cat "$work/stderr" >&2; exit 1; }
cached=$XDG_CACHE_HOME/reeval/bin/$version/$asset
cmp -s "$cached" "$binary"
grep -q "^1 pass$" "$work/stdout"

REEVAL_OFFLINE=1 REEVAL_DOWNLOAD=file:///nowhere go tool reeval run --dry-run 2> "$work/stderr" >/dev/null
if grep -q downloading "$work/stderr"; then echo "go-tool-smoke: downloaded again" >&2; exit 1; fi
echo "go-tool-smoke: go get -tool, then go tool reeval run on $asset, from the download and offline"
