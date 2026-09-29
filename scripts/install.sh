#!/bin/sh
# Installs the reeval binary: curl -fsSL https://reeval.ai/install.sh | sh
#
#   REEVAL_DOWNLOAD_URL  where to get the binary (default: reeval.ai's build for this platform);
#                        a file:// URL installs a local build
#   REEVAL_INSTALL       where to install (default: ~/.reeval); the binary goes in its bin/
#
# Experimental: nothing publishes binaries yet. Build one with node scripts/bun-compile.mjs.
set -eu

fail() {
  echo "reeval install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no reeval build for $(uname -s); install the npm package instead: npm i -D reeval" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no reeval build for $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"

url="${REEVAL_DOWNLOAD_URL:-https://reeval.ai/download/latest/reeval-$os-$arch}"
dir="${REEVAL_INSTALL:-$HOME/.reeval}"
bin="$dir/bin"
mkdir -p "$bin"

tmp="$(mktemp "$bin/.reeval.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
echo "Downloading reeval ($os-$arch) from $url"
curl -fsSL "$url" -o "$tmp" || fail "download failed: $url"
chmod 755 "$tmp"
version="$("$tmp" --version 2>/dev/null)" || fail "the downloaded file doesn't run on this machine"
mv "$tmp" "$bin/reeval"
trap - EXIT

echo "Installed reeval $version to $bin/reeval"
case ":$PATH:" in
  *":$bin:"*) ;;
  *)
    echo
    echo "Add it to your PATH, e.g. in ~/.profile or ~/.zshrc:"
    echo "  export PATH=\"$bin:\$PATH\""
    ;;
esac
