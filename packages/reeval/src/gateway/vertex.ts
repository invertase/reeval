// Vertex AI as a gateway: what it can't serve, for the plan's messages.
import type { AgentKind } from '../harness/agents.ts'

/** Why Vertex AI can't serve an agent, beyond the ones reeval doesn't route there yet. */
export const VERTEX_REFUSALS: Partial<Record<AgentKind, string>> = {
  cursor: "Cursor's agent only calls Cursor's own API",
  codex: "Codex only calls OpenAI's Responses API, which Vertex AI doesn't serve",
}
