import type { AgentLog, HarnessSession, PlacedPlugin } from '@reeval/agents'
import type { HarnessSkill, ResolvedMcpServer } from '../environment/resolve.ts'
import type { Sandbox } from '../sandbox/types.ts'

/** What an environment gives the agent itself; each adapter puts it where its agent looks. */
export type Treatments = {
  skills: HarnessSkill[]
  /** Skills already written into the workspace's skill directory (placement `workspace`). */
  workspaceSkills: string[]
  /** Secret values are already resolved. */
  mcp: Record<string, ResolvedMcpServer>
  /**
   * Plugins the session copied into the sandbox, each at `dir` (absolute) with the parts `only`
   * kept; the adapter makes its agent load them. `servers` are the keys of its MCP servers in
   * `mcp` (`<plugin>:<server>`, `${CLAUDE_PLUGIN_ROOT}` and secrets filled in), so an adapter whose
   * agent loads the plugin's own MCP config can leave them out of `mcp` rather than start them twice.
   */
  plugins: PlacedPlugin[]
}

export type { PlacedPlugin }

export interface Harness {
  start(
    sandbox: Sandbox,
    signal: AbortSignal,
    treatments: Treatments,
    log: AgentLog,
  ): Promise<HarnessSession>
}
