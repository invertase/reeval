import { defineEnvironment } from 'reeval'

const install = `set -e
bin=$(command -v reeval || true)
if [ -n "$bin" ] && [ -d "$(dirname "$bin")/../reeval" ]; then
  ln -s "$(dirname "$bin")/.." node_modules
else
  npm install --prefix "$HOME/.reeval-cli" --no-audit --no-fund --loglevel=error reeval@0.9.0
  ln -s "$HOME/.reeval-cli/node_modules" node_modules
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.reeval-cli/node_modules/.bin/reeval" "$HOME/.local/bin/reeval"
fi`

const seedFailingRun = `for i in 1 2 3; do
  node_modules/.bin/reeval run --ui plain > /dev/null 2>&1 || exit 0
done
echo "the fixture passed three runs in a row, so there is nothing to debug" >&2
exit 1`

export const checkPath = defineEnvironment('check-path', ({ directory }) => ({
  files: directory('../fixtures/check-path'),
  env: { DOGFOOD_TASK: 'check-path' },
  setup: [
    { run: install, timeout: '5m' },
    { run: seedFailingRun, timeout: '3m' },
  ],
}))
