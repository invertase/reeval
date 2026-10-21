import { defineEnvironment, evaluate } from 'reeval'

// Codex and Goose load a plugin's skills and MCP servers, so the rest is left out.
const review = defineEnvironment('review', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/review', { only: ['skills', 'mcp'] })],
}))

evaluate('loads the plugin', { environment: review }, async () => {})
