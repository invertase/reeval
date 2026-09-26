import type { Sandbox } from '../sandbox/index.ts'
import type { EvalRecord } from '../types.ts'
import type { Attempt } from './state.ts'

/** Under the home directory, and under each adapter's own home, which an installed CLI runs with. */
const HOME_CONTEXT_PATHS = [
  '.cursor/mcp.json',
  '.cursor/cli-config.json',
  '.cursor/rules',
  '.cursor/skills',
  '.cursor/skills-cursor',
  '.agents/skills',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.claude/skills',
]
/** Where the AI SDK adapters install their CLI; the CLI's `$HOME` is `home` under it. */
const ADAPTER_HOMES = '"$HOME"/.ai-sdk-harness/.harness-bootstrap/*/implementation/home'

/**
 * Skills, rules and MCP config the agent could load, with content hashes (never contents).
 * Paths under the home directory are shown as `~/…`; others are relative to the workspace.
 */
const CONTEXT_PATHS = [
  ...HOME_CONTEXT_PATHS.map((p) => `$HOME/${p}`),
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.cursor/rules',
  '.cursor/skills',
  '.cursor/mcp.json',
  '.claude/settings.json',
  '.claude/skills',
  '.agents/skills',
  '.mcp.json',
]

async function agentContext(box: Sandbox, signal: AbortSignal): Promise<EvalRecord['context']> {
  const adapterPaths = `for h in ${ADAPTER_HOMES}; do for p in ${HOME_CONTEXT_PATHS.join(' ')}; do echo "$h/$p"; done; done`
  const script = `{ for p in ${CONTEXT_PATHS.map((p) => `"${p}"`).join(' ')}; do echo "$p"; done; ${adapterPaths}; } | while IFS= read -r p; do [ -e "$p" ] && find "$p" -type f 2>/dev/null; done | sort | head -500 | while IFS= read -r f; do printf '%s\t%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done`
  const r = await box.exec(script, { signal }).catch(() => null)
  if (r?.exitCode !== 0) return []
  const home = (await box.exec('printf %s "$HOME"', { signal }).catch(() => null))?.stdout ?? ''
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t')
      const path = rest.join('\t')
      return {
        path: home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path,
        sha256: sha ?? '',
      }
    })
}

/**
 * Records the agent's context once, after the first turn (or at teardown when there was none):
 * adapters write harness skills when a turn starts, so before it the record would miss them.
 */
export function contextTaker(a: Attempt) {
  let taken = false
  return async (box: Sandbox, signal: AbortSignal) => {
    if (taken || a.spec.sandbox.kind !== 'docker') return
    taken = true
    a.record.context = await agentContext(box, signal)
  }
}
