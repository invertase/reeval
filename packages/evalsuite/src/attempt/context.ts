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
  '.gemini/GEMINI.md',
  '.gemini/AGENTS.md',
  '.gemini/config/skills',
  '.gemini/config/rules',
  '.gemini/config/mcp_config.json',
  '.gemini/antigravity-cli/settings.json',
  '.config/opencode/skills',
  '.config/opencode/opencode.json',
  '.config/opencode/opencode.jsonc',
  '.config/opencode/AGENTS.md',
  '.opencode/skills',
  '.config/goose/skills',
  '.config/goose/config.yaml',
  '.config/goose/.goosehints',
  '.pi/agent/skills',
  '.pi/agent/AGENTS.md',
  '.pi/agent/settings.json',
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
  'GEMINI.md',
  '.cursorrules',
  '.cursor/rules',
  '.cursor/skills',
  '.cursor/mcp.json',
  '.claude/settings.json',
  '.claude/skills',
  '.agents/skills',
  '.agents/rules',
  '.agents/mcp_config.json',
  '.mcp.json',
  '.opencode/skills',
  'opencode.json',
  'opencode.jsonc',
  '.goosehints',
  '.goose/skills',
  '.pi/skills',
  '.pi/settings.json',
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

const ADAPTER_HOME = /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/[^/]+\/implementation\/home\//

/**
 * Files the Cursor CLI (the ACP harness `cursor()` used before the Cursor SDK) rewrote every
 * session, under `~/` or its adapter's home. Records from then still list them; no current
 * harness writes session state into the paths ES records.
 */
const RETIRED_RUNTIME_STATE = new Set([
  '.cursor/cli-config.json',
  '.cursor/skills-cursor/.sync-manifest.json',
])

/** A context path that is some agent CLI's own runtime state, whichever harness recorded it. */
export function isRuntimeState(path: string): boolean {
  if (!path.startsWith('~/')) return false
  return RETIRED_RUNTIME_STATE.has(path.replace(ADAPTER_HOME, '~/').slice(2))
}
