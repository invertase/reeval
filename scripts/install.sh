#!/bin/sh
{
main() {
  # Installs the reeval binary from a GitHub release, checked against the release's SHA256SUMS.
  #
  #   curl -fsSL https://raw.githubusercontent.com/invertase/reeval/main/scripts/install.sh | sh
  #
  # REEVAL_VERSION     a version (0.13.0) instead of the newest release
  # REEVAL_INSTALL_DIR where to put `reeval` (default ~/.local/bin)
  # REEVAL_DOWNLOAD    where the release's files are, instead of its GitHub release (needs REEVAL_VERSION)
  #
  # Everything is inside main, called inside a group the last line closes, so a download cut
  # short runs none of it and, past the first line, fails (scripts/install-test.sh checks every
  # prefix).
  set -eu

  REPO=invertase/reeval

  fail() {
    echo "reeval install: $*" >&2
    exit 1
  }

  command -v curl >/dev/null || fail "curl is required"

  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "no binary for $(uname -s); on Windows, use install.ps1" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "no binary for $(uname -m)" ;;
  esac
  # An x64 shell on Apple silicon (Rosetta) gets the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    arch=arm64
  fi
  target=$os-$arch
  if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ls /lib/ld-musl-* >/dev/null 2>&1; }; then
    target=$target-musl
  fi

  version=${REEVAL_VERSION:-}
  version=${version#v}
  if [ -z "$version" ]; then
    [ -z "${REEVAL_DOWNLOAD:-}" ] || fail "REEVAL_DOWNLOAD needs REEVAL_VERSION"
    # The newest reeval release: the repository's other releases are tagged <component>-v<version>.
    releases=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30") ||
      fail "couldn't list the releases of $REPO"
    version=$(printf '%s\n' "$releases" | sed -n 's/.*"tag_name": *"v\([0-9][^"]*\)".*/\1/p' | head -n 1)
    [ -n "$version" ] || fail "no release of $REPO found"
  fi
  base=${REEVAL_DOWNLOAD:-https://github.com/$REPO/releases/download/v$version}
  name=reeval-$version-$target
  dir=${REEVAL_INSTALL_DIR:-$HOME/.local/bin}

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "reeval install: $name"
  curl -fsL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
    fail "reeval $version has no binaries ($base/SHA256SUMS)"
  curl -fSL --progress-bar -o "$tmp/$name" "$base/$name" || fail "couldn't download $base/$name"

  expected=$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS doesn't list $name"
  if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$tmp/$name" | cut -d ' ' -f 1)
  else
    actual=$(shasum -a 256 "$tmp/$name" | cut -d ' ' -f 1)
  fi
  [ "$actual" = "$expected" ] || fail "$name doesn't match SHA256SUMS (got $actual, expected $expected)"

  mkdir -p "$dir"
  chmod +x "$tmp/$name"
  mv "$tmp/$name" "$dir/reeval"
  echo "reeval install: reeval $("$dir/reeval" --version) at $dir/reeval"

  case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "reeval install: $dir isn't on your PATH; add it, e.g. export PATH=\"$dir:\$PATH\"" ;;
  esac
  command -v git >/dev/null || echo "reeval install: reeval needs git, which isn't on your PATH"
}

main "$@"
}
