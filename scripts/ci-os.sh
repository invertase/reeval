#!/usr/bin/env bash
# extended.yml's Windows and macOS legs: every tier that needs no Docker, one part at a time.
#
#   scripts/ci-os.sh unit 2/4    a shard of the unit and plan test files
#   scripts/ci-os.sh tiers       typecheck, schema check, lint, fixtures (fake tier), studio, the other packages
#   scripts/ci-os.sh packed      the pack test, then reeval init → run → doctor → studio build from the tarball
#
# Run after `pnpm install` and `pnpm build`, from anywhere in the repo.
set -euo pipefail
shopt -s extglob

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
node_test() { node --test --test-timeout=300000 --experimental-strip-types --no-warnings "$@"; }

part=${1:?usage: ci-os.sh unit [i/n] | tiers | packed}

# A --dry-run or reeval doctor asks Docker whether it runs Linux containers. On a fresh Windows runner
# the first `docker info` takes from seconds to over a minute (later ones take 0.1 s), which would
# land on whichever test asks first; ask once here instead.
if command -v docker >/dev/null; then docker info --format '{{.OSType}}' >/dev/null 2>&1 || true; fi
case $part in
  unit)
    cd packages/reeval
    files=(test/!(features|docker|docker-antigravity|studio|pack|contract|e2e-real|questions-real|openrouter-real).test.ts)
    # Shard by each file's running time: a few files take most of it, so round-robin
    # (--test-shard) can stack them in one shard.
    if [ -n "${2:-}" ]; then
      shard=$(node "$root/scripts/test-shard.mjs" "$2" "${files[@]}")
      mapfile -t files <<<"${shard//$'\r'/}"
    fi
    node_test "${files[@]}"
    ;;

  tiers)
    pnpm typecheck
    pnpm --filter reeval schema:check
    pnpm exec biome ci .
    (cd packages/reeval && REEVAL_FIXTURE_TIERS=fake node_test test/features.test.ts test/studio.test.ts)
    for p in sandbox-docker harness-antigravity harness-cursor-sdk harness-opencode harness-goose harness-pi harness-codex harness-fx harness-grok-build; do
      pnpm --filter "@reeval/$p" test
    done
    # The browser test skips without Chrome: count that as a failure here.
    pnpm --filter studio-web test 2>&1 | tee "${RUNNER_TEMP:-/tmp}/studio-web.log"
    grep -Eq '^(ℹ|#) skipped 0' "${RUNNER_TEMP:-/tmp}/studio-web.log"
    ;;

  packed)
    (cd packages/reeval && node_test test/pack.test.ts)
    work=$(mktemp -d)
    pnpm --filter reeval pack --pack-destination "$work"
    tarball=$(cd "$work" && ls ./*.tgz)
    reeval() { npx --no-install reeval "$@"; }

    # A fresh project, its eval run on the fake agent: init, run, doctor and a studio build of the run.
    mkdir "$work/fake" && cd "$work/fake"
    npm init -y >/dev/null
    npm install --no-audit --no-fund "../$tarball"
    reeval init -y
    cat >fake.config.ts <<'EOF'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],
  harnesses: fakeHarness({
    files: { 'greet.js': 'export const greet = (name) => `Hello, ${name}!`\n' },
  }),
  sandbox: fakeSandbox(),
})
EOF
    reeval run --config fake.config.ts
    reeval doctor --config fake.config.ts
    reeval studio build --scratch | tee build.log
    grep -q 'built studio-dist/: 1 run' build.log

    # A fresh project on Docker: doctor names what this machine's Docker lacks, with the fix.
    mkdir "$work/docker" && cd "$work/docker"
    npm init -y >/dev/null
    npm install --no-audit --no-fund "../$tarball"
    reeval init -y --harness cursor | tee init.log
    os=$(docker info --format '{{.OSType}}' 2>/dev/null || true)
    if reeval doctor >doctor.log 2>&1; then status=0; else status=$?; fi
    cat doctor.log
    case $os in
      linux) grep -q '^Docker is running: ready for npx reeval image build$' init.log ;;
      windows)
        [ "$status" = 1 ] && grep -q "is running Windows containers, but reeval's sandboxes are Linux containers" doctor.log &&
          grep -q 'Switch to Linux containers' doctor.log &&
          grep -q '^Docker is running Windows containers' init.log
        ;;
      *)
        [ "$status" = 1 ] && grep -Eq "isn't (running|installed).*, and the config's sandboxes need it" doctor.log &&
          grep -Eq "^Docker isn't (running|installed): .*, then run npx reeval image build$" init.log
        case $(uname -s) in
          MINGW* | MSYS*) grep -q 'WSL 2 backend and Linux containers' doctor.log ;;
        esac
        ;;
    esac
    rm -rf "$work"
    ;;

  *)
    echo "usage: ci-os.sh unit [i/n] | tiers | packed" >&2
    exit 2
    ;;
esac
