#!/usr/bin/env bash
# ci.yml's Windows and macOS legs: every tier that needs no Docker, one part at a time.
#
#   scripts/ci-os.sh unit 2/4    a shard of the unit and plan test files
#   scripts/ci-os.sh tiers       typecheck, lint, fixtures (fake tier), studio, the other packages
#   scripts/ci-os.sh packed      the pack test, then es init → run → doctor → studio build from the tarball
#
# Run after `pnpm install` and `pnpm build`, from anywhere in the repo.
set -euo pipefail
shopt -s extglob

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
node_test() { node --test --test-timeout=300000 --experimental-strip-types --no-warnings "$@"; }

part=${1:?usage: ci-os.sh unit [i/n] | tiers | packed}
case $part in
  unit)
    cd packages/evalsuite
    node_test ${2:+--test-shard=$2} \
      test/!(features|docker|docker-antigravity|studio|pack|contract|e2e-real).test.ts
    ;;

  tiers)
    pnpm typecheck
    pnpm --filter @invertase/foobar schema:check
    pnpm exec biome ci .
    (cd packages/evalsuite && ES_FIXTURE_TIERS=fake node_test test/features.test.ts test/studio.test.ts)
    for p in sandbox-docker harness-antigravity harness-cursor-sdk harness-opencode harness-goose harness-pi harness-codex; do
      pnpm --filter "@evalsuite/$p" test
    done
    # The browser test skips without Chrome: count that as a failure here.
    pnpm --filter studio-web test 2>&1 | tee "${RUNNER_TEMP:-/tmp}/studio-web.log"
    grep -Eq '^(ℹ|#) skipped 0' "${RUNNER_TEMP:-/tmp}/studio-web.log"
    ;;

  packed)
    (cd packages/evalsuite && node_test test/pack.test.ts)
    work=$(mktemp -d)
    pnpm --filter @invertase/foobar pack --pack-destination "$work"
    tarball=$(cd "$work" && ls ./*.tgz)
    es() { npx --no-install es "$@"; }

    # A fresh project on the fake agent: init, run, doctor and a studio build of the run.
    mkdir "$work/fake" && cd "$work/fake"
    npm init -y >/dev/null
    npm install --no-audit --no-fund "../$tarball"
    es init -y --harness none
    es run
    es doctor
    es studio build --scratch | tee build.log
    grep -q 'built studio-dist/: 1 run' build.log

    # A fresh project on Docker: doctor names what this machine's Docker lacks, with the fix.
    mkdir "$work/docker" && cd "$work/docker"
    npm init -y >/dev/null
    npm install --no-audit --no-fund "../$tarball"
    es init -y --harness cursor
    os=$(docker info --format '{{.OSType}}' 2>/dev/null || true)
    if es doctor >doctor.log 2>&1; then status=0; else status=$?; fi
    cat doctor.log
    case $os in
      linux) ;;
      windows)
        [ "$status" = 1 ] && grep -q "is running Windows containers, but ES's sandboxes are Linux containers" doctor.log &&
          grep -q 'Switch to Linux containers' doctor.log
        ;;
      *)
        [ "$status" = 1 ] && grep -q "isn't running, and the config's sandboxes need it" doctor.log
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
