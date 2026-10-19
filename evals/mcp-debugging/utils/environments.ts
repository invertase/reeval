import { defineEnvironment } from 'reeval'

/**
 * The reeval the sandbox installs when it has none on PATH (Docker): a tarball from `pnpm pack`
 * when REEVAL_DOGFOOD_TARBALL names one, else this published version. Fake runs use the
 * workspace's.
 */
const PUBLISHED = '0.9.0'
const tarball = process.env.REEVAL_DOGFOOD_TARBALL

const install = `set -e
bin=$(command -v reeval || true)
if [ -n "$bin" ] && [ -d "$(dirname "$bin")/../reeval" ]; then
  ln -s "$(dirname "$bin")/.." node_modules
else
  npm install --prefix "$HOME/.reeval-cli" --no-audit --no-fund --loglevel=error ${tarball ? '"$HOME/reeval.tgz"' : `reeval@${PUBLISHED}`}
  ln -s "$HOME/.reeval-cli/node_modules" node_modules
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.reeval-cli/node_modules/.bin/reeval" "$HOME/.local/bin/reeval"
fi`

// Leaves the failing run the agent is asked about in .reeval/. The flaky fixture passes about
// half its attempts, so it may take more than one run to fail.
const seedFailingRun = `for i in 1 2 3; do
  node_modules/.bin/reeval run --ui plain > /dev/null 2>&1 || exit 0
done
echo "the fixture passed three runs in a row, so there is nothing to debug" >&2
exit 1`

/**
 * A broken reeval project and the same project with `reeval mcp` configured as a stdio MCP server
 * named `reeval`. A `history` task starts from `base` and builds a git history with a recorded
 * run per commit (scripts/seed-history.mjs); any other starts from its fixture and its failing run.
 */
export function brokenProject(fixture: string, history?: { base: string }) {
  const control = defineEnvironment(fixture, ({ directory, file }) => ({
    files: {
      ...directory(`../../../fixtures/mcp-${history?.base ?? fixture}`),
      ...(history ? { '~/.dogfood-seed.mjs': file('./scripts/seed-history.mjs') } : {}),
      ...(tarball ? { '~/reeval.tgz': file(tarball) } : {}),
    },
    env: { DOGFOOD_TASK: fixture },
    setup: [
      { run: install, timeout: '5m' },
      history
        ? { run: `node ~/.dogfood-seed.mjs ${fixture}`, timeout: '8m' }
        : { run: seedFailingRun, timeout: '3m' },
    ],
  }))
  const variant = control.extendEnvironment(`${fixture}-with-mcp`, ({ mcp }) => ({
    mcp: {
      // reeval mcp reads the config of the directory it starts in, which the harness picks.
      reeval: mcp.stdio('sh', [
        '-c',
        'cd /reeval/workspace 2>/dev/null; exec node_modules/.bin/reeval mcp',
      ]),
    },
  }))
  return { control, variant }
}
