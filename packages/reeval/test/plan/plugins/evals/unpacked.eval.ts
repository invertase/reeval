import { defineEnvironment, evaluate, type HarnessOption, type PluginPart } from 'reeval'

// OpenCode, pi and fx take a plugin unpacked, each the parts it has a place for: OpenCode its
// skills, subagents, commands and MCP servers, pi its skills, commands and MCP servers, and fx its
// skills and MCP servers.
const review = (name: string, only: PluginPart[]) =>
  defineEnvironment(name, ({ plugin }) => ({
    plugins: [plugin.local('../plugins/review', { only })],
  }))
const on =
  (kind: string): HarnessOption =>
  (inherited) =>
    inherited.filter((h) => h.kind === kind)

evaluate(
  'opencode loads the plugin',
  {
    environment: review('opencode', ['skills', 'agents', 'commands', 'mcp']),
    harness: on('opencode'),
  },
  async () => {},
)
evaluate(
  'pi loads the plugin',
  { environment: review('pi', ['skills', 'commands', 'mcp']), harness: on('pi') },
  async () => {},
)
evaluate(
  'fx loads the plugin',
  { environment: review('fx', ['skills', 'mcp']), harness: on('fx') },
  async () => {},
)
