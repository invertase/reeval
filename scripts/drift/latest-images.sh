#!/usr/bin/env bash
# The version-drift job's "latest" leg: swaps the newest agent CLI or SDK into ES's pinned sandbox
# images, in place, so the contract suite runs against what users would get today. Needs the
# pinned images built first (es image build, or .github/actions/sandbox-images).
#   Antigravity: the newest google-antigravity/antigravity-cli release's `agy` (its releases
#     publish no checksums, so unlike the pinned build this one isn't verified).
#   Cursor: the newest @cursor/sdk from npm, in the SDK harness's bootstrap directory.
#   OpenCode: the newest opencode-ai from npm in its bootstrap (its postinstall allowed), and the
#     same release of the plugin runtime the image bakes, so it still starts offline.
#   Goose: the newest aaif-goose/goose release's `goose`, in its private home (not verified,
#     as for agy).
#   pi: the newest @earendil-works/pi-coding-agent from npm, in its bootstrap directory.
# ES_DRIFT_ANTIGRAVITY_VERSION, ES_DRIFT_CURSOR_SDK_VERSION, ES_DRIFT_OPENCODE_VERSION,
# ES_DRIFT_GOOSE_VERSION (a tag, e.g. v1.51.0) and ES_DRIFT_PI_VERSION name a version instead of
# the newest, e.g. to bisect a drift failure.
# Prints what it swapped, and appends a table to $GITHUB_STEP_SUMMARY when it's set.
set -euo pipefail
cd "$(dirname "$0")/../.."

images=$(node --input-type=module -e "
  import { BAKED_HARNESSES, imageFor } from './packages/sandbox-docker/dist/index.js'
  console.log(BAKED_HARNESSES.map((h) => h + '=' + imageFor(h)).join(' '))")
# The swap scripts end with this, so a swap that leaves the old CLI in place fails the leg.
expect_fn='expect() { echo "$2"; case "$2" in *"$1"*) ;; *) echo "expected $1, got $2" >&2; exit 1 ;; esac; }'
label() { docker inspect "$1" --format '{{index .Config.Labels "dev.evalsuite.agent-version"}}'; }
rows=()

for pair in $images; do
  harness=${pair%%=*}
  image=${pair#*=}
  docker image inspect "$image" >/dev/null 2>&1 || { echo "skipped $image: not built"; continue; }
  pinned=$(label "$image")
  version=${pinned##* }
  new_label=""
  bootstrap=/root/.ai-sdk-harness/.harness-bootstrap
  case "$harness" in
    antigravity)
      latest=${ES_DRIFT_ANTIGRAVITY_VERSION:-}
      [ -n "$latest" ] || latest=$(curl -fsSL --retry 3 ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
        https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')
      swap="set -eu
case \"\$(uname -m)\" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
curl -fsSL --retry 3 -o /tmp/agy.tgz https://github.com/google-antigravity/antigravity-cli/releases/download/$latest/agy_cli_linux_\$arch.tar.gz
mkdir -p /tmp/agy && tar -xzf /tmp/agy.tgz -C /tmp/agy
install -m 755 /tmp/agy/antigravity $bootstrap/antigravity/bin/agy
rm -rf /tmp/agy /tmp/agy.tgz
$bootstrap/antigravity/bin/agy --version"
      ;;
    cursor)
      if ! docker run --rm --entrypoint test "$image" -d "$bootstrap/cursor-sdk"; then
        rows+=("| cursor | $pinned | — | no SDK bootstrap in $image, nothing to swap |")
        continue
      fi
      latest=${ES_DRIFT_CURSOR_SDK_VERSION:-$(npm view @cursor/sdk version)}
      new_label="@cursor/sdk $latest"
      swap="set -eu
cd $bootstrap/cursor-sdk
npm install --omit=dev --no-audit --no-fund --loglevel=error --save-exact @cursor/sdk@$latest
node -p \"JSON.parse(require('fs').readFileSync('node_modules/@cursor/sdk/package.json')).version\""
      ;;
    opencode)
      latest=${ES_DRIFT_OPENCODE_VERSION:-$(npm view opencode-ai version)}
      swap="set -eu
cd $bootstrap/opencode/implementation
printf 'allowBuilds:\\n  %s: true\\n' \"'opencode-ai@$latest'\" > pnpm-workspace.yaml
pnpm add --save-exact --store-dir $bootstrap/opencode/.pnpm-store opencode-ai@$latest >/dev/null
cd /root/.config/opencode
printf '{\"dependencies\":{\"@opencode-ai/plugin\":\"%s\"}}\\n' $latest > package.json
rm -rf node_modules package-lock.json
npm install --no-fund --no-audit --ignore-scripts --loglevel=error
expect \"$latest\" \"\$($bootstrap/opencode/implementation/node_modules/.bin/opencode --version)\""
      ;;
    goose)
      tag=${ES_DRIFT_GOOSE_VERSION:-}
      [ -n "$tag" ] || tag=$(curl -fsSL --retry 3 ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
        https://api.github.com/repos/aaif-goose/goose/releases/latest |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')
      latest=${tag#v}
      bin=$bootstrap/goose/implementation/home/.local/bin
      swap="set -eu
case \"\$(uname -m)\" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; esac
curl -fsSL --retry 3 -o /tmp/goose.tgz https://github.com/aaif-goose/goose/releases/download/$tag/goose-\$arch-unknown-linux-gnu.tar.gz
tar -xzf /tmp/goose.tgz -C $bin ./goose
rm /tmp/goose.tgz
expect \"$latest\" \"\$($bin/goose --version)\""
      ;;
    pi)
      latest=${ES_DRIFT_PI_VERSION:-$(npm view @earendil-works/pi-coding-agent version)}
      swap="set -eu
cd $bootstrap/pi
pnpm add --save-exact --ignore-scripts @earendil-works/pi-coding-agent@$latest >/dev/null
expect \"$latest\" \"\$($bootstrap/pi/node_modules/.bin/pi --version)\""
      ;;
    *)
      rows+=("| $harness | $pinned | — | not swapped: runs on the pinned CLI |")
      continue
      ;;
  esac
  new_label=${new_label:-$latest}
  if [ "$latest" = "$version" ]; then
    rows+=("| $harness | $pinned | $latest | already the latest |")
    continue
  fi
  echo "swapping $harness $pinned → $latest in $image"
  context=$(mktemp -d)
  printf '%s\n%s\n' "$expect_fn" "$swap" > "$context/swap.sh"
  printf 'FROM %s\nCOPY swap.sh /tmp/swap.sh\nRUN bash /tmp/swap.sh && rm /tmp/swap.sh\nLABEL dev.evalsuite.agent-version=%s\n' \
    "$image" "\"$new_label\"" > "$context/Dockerfile"
  docker build -q -t "$image" "$context" >/dev/null
  rm -rf "$context"
  [ "$(label "$image")" = "$new_label" ]
  rows+=("| $harness | $pinned | **$latest** | swapped in |")
done

table=$(printf '%s\n' "### Agent versions (latest leg)" "" "| harness | pinned | latest | |" "|---|---|---|---|" "${rows[@]}")
echo "$table"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n\n' "$table" >> "$GITHUB_STEP_SUMMARY"; fi
