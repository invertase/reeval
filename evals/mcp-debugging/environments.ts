import { defineEnvironment } from 'reeval'

/** The reeval the sandbox installs when it has none on PATH (Docker); fake runs use the workspace's. */
const REEVAL_VERSION = '0.9.0'

const install = `set -e
bin=$(command -v reeval || true)
if [ -n "$bin" ] && [ -d "$(dirname "$bin")/../reeval" ]; then
  ln -s "$(dirname "$bin")/.." node_modules
else
  npm install --prefix "$HOME/.reeval-cli" --no-audit --no-fund --loglevel=error reeval@${REEVAL_VERSION}
  ln -s "$HOME/.reeval-cli/node_modules" node_modules
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.reeval-cli/node_modules/.bin/reeval" "$HOME/.local/bin/reeval"
fi`

// Records the failing run the agent is asked about. The flaky fixture passes about half its
// attempts, so it may take more than one run to fail.
const seed = `for i in 1 2 3; do
  node_modules/.bin/reeval run --ui plain > /dev/null 2>&1 || exit 0
done
echo "the fixture passed three runs in a row, so there is nothing to debug" >&2
exit 1`

/**
 * A broken reeval project with its failing run in `.reeval/`, and the same project with
 * `reeval mcp` configured as a stdio MCP server named `reeval`.
 */
export function brokenProject(fixture: string) {
  const control = defineEnvironment(fixture, ({ directory }) => ({
    files: directory(`./fixtures/${fixture}`),
    setup: [
      { run: install, timeout: '5m' },
      { run: seed, timeout: '3m' },
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
