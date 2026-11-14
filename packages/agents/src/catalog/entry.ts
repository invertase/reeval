import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import type { PluginPart, ResolvedMcpServer } from '../spec.ts'
import type { WebEventType } from '../types.ts'
import type { Layout } from './layouts.ts'

/** The kind of a real agent's harness, e.g. `cursor` or `claude-code`. */
export type AgentKind =
  | 'cursor'
  | 'claude-code'
  | 'antigravity'
  | 'opencode'
  | 'goose'
  | 'pi'
  | 'codex'
  | 'fx'
  | 'grok-build'

/** What reeval needs to know about a real agent's harness, wherever it runs and whatever routes its requests. */
export type HarnessEntry = Layout & {
  /** For messages. */
  name: string
  /** The `reeval/harness` factory, for messages. */
  factory: string
  /** The platforms its bootstrap installs the agent's CLI for: a sandbox on another can't run it. */
  platforms: readonly NodeJS.Platform[]
  /**
   * Set when its CLI's macOS build verifies TLS with Security.framework (Go, `native-tls`,
   * `rustls-platform-verifier`), which reads only the keychain's trust settings, not
   * `SSL_CERT_FILE`: in `tart()` it reaches the gateway only once the gateway's CA is trusted there.
   */
  keychainTrust?: true
  /**
   * Set when its adapter's bridge is a server in the sandbox that the host connects to on the
   * session's first exposed port (`resolveBridgePort`): a session exposing none can't start it.
   */
  bridgePort?: true
  /**
   * The host variable the harness authenticates with. It never enters the sandbox. With `token`,
   * what the token is minted from, for messages.
   */
  credential: string
  /**
   * Host variables the harness authenticates with when `credential` isn't set, in the order it
   * takes them (Claude Code's subscription token). The first one set is passed and brokered like
   * `credential`, and the agent never gets another. A gateway's route takes none of them.
   */
  fallbackCredentials?: readonly string[]
  /** The model id the agent asks for, from the harness's own; unset when they're the same. */
  modelId?: (model: string) => string
  /**
   * Why it can't take a plugin that bundles ChatGPT apps, which it would otherwise load with the
   * plugin; unset for an agent that ignores them.
   */
  pluginApps?: string
  /**
   * Plugin manifests it reads in place of `.claude-plugin/plugin.json` when a plugin has one, so it
   * would load what reeval didn't place or rewrite; unset for an agent that reads only that one.
   */
  pluginManifestsFirst?: readonly string[]
  /** It reads a root `plugin.json` only when it names an Agent Plugins `$schema`. */
  pluginRootManifestNeedsSchema?: true
  /**
   * Transcript events a turn may have had that its harness didn't report, from the turn's
   * `finish` part's `harnessMetadata`. Each turn carries these as `unreported`, so web matchers
   * refuse instead of passing silently.
   */
  unreported?: (harnessMetadata: unknown) => WebEventType[]
  /**
   * What the agent said its turn cost, in US dollars, from the turn's `finish` part's
   * `harnessMetadata`. `session` names a running total over the session's turns (Claude Code's
   * `total_cost_usd`), so the turn's cost is the rise since the session's last turn.
   */
  reportedCost?: (harnessMetadata: unknown) => { usd: number; session?: string } | undefined
  /**
   * How the agent's reasoning reaches reeval, which decides whether a turn's reasoning time is
   * measured: `streamed`, as the model produces it, so each block is timed; `recovered`, read
   * back from the agent's stored conversation after the turn, with the time the agent stored
   * for each block (Antigravity's `thinking_duration`); `whole`, each block only once it's done
   * (Codex's reasoning items), so its time is unknown; `none`, never (the model's thinking stays
   * inside the CLI), so its time is unknown too. Reasoning tokens are apart from this: they come
   * from the turn's usage.
   */
  reasoning: ReasoningDelivery
  /**
   * Whether the turn's usage counts reasoning tokens apart (`usage.reasoning`): `provider` when it
   * depends on the model's provider (OpenCode, fx). For the docs; usage itself says per turn.
   */
  reasoningTokens: boolean | 'provider'
  /**
   * Reads back the usage the agent's CLI stored for each model call, for a turn whose stream
   * reported none: an aborted turn's, whose stream ends before the turn's usage. Unset for a CLI
   * that stores no usage per call (fx), stores none for a canceled run (Cursor) or whose stream
   * always has it.
   */
  storedUsage?: () => Promise<StoredUsage>
  /**
   * Tools whose result the agent reports whole while its model gets a cut of it, so their
   * transcript `output` is the `full` view; `'all'` for every tool. Unset, every tool's output is
   * what the model saw, except one its adapter read from where the CLI saved it.
   */
  fullToolOutput?: 'all' | readonly string[]
  /**
   * Set when the transcript has a subagent's tool calls, so its edits count as file edits (Claude
   * Code's bridge passes a subagent's messages on raw, and reeval reads them). Unset, only the
   * workspace diff's `changedFiles` shows what a subagent changed.
   */
  subagentCalls?: true
  /**
   * Set for an agent on `@ai-sdk/harness-acp`, whose `stream-start` names the ACP session's model:
   * the one the agent was configured with, not the one that served the turn. Its turns record
   * what the gateway read from the model calls instead.
   */
  configuredModelOnStart?: true
  /** The plugin parts reeval places for the agent; empty refuses every plugin. */
  pluginParts: readonly PluginPart[]
  /**
   * Set for an agent that takes plugins namespaced but names a plugin's MCP servers by their own
   * keys, in one list with the environment's (Grok Build, Codex): it keeps one of two servers of a name.
   */
  pluginServersByName?: true
  /** reeval's MCP servers in the shape the adapter forwards to the agent as is. */
  mcpServers: (servers: Record<string, ResolvedMcpServer>) => Record<string, unknown>
}

/** A catalog entry: one whose credential depends on its model has none of its own (OpenCode, Goose, pi, fx). */
export type HarnessCatalogEntry =
  | HarnessEntry
  | (Omit<HarnessEntry, 'credential'> & { credential?: undefined })

/** A harness adapter's usage, in the AI SDK's provider shape. */
export type HarnessUsage = Extract<HarnessV1StreamPart, { type: 'finish' }>['totalUsage']

/** Reads a CLI's stored usage in the sandbox; see `Agent.storedUsage`. */
export type StoredUsage = {
  /**
   * The command that prints the usage of the model calls since `since` (ms since the epoch), or
   * after `mark` when an earlier read, or `mark` below, gave one.
   */
  command: (o: { since: number; mark?: string }) => string
  /** What it printed; undefined when it read nothing. `mark` is where the next read starts. */
  parse: (stdout: string) => { usage: HarnessUsage; calls: number; mark?: string } | undefined
  /** Where the next read starts, from the `raw` of the usage a turn's stream reported. */
  mark?: (raw: unknown) => string | undefined
}

/** How an agent's reasoning reaches reeval; see `Agent.reasoning`. */
export type ReasoningDelivery = 'streamed' | 'recovered' | 'whole' | 'none'
