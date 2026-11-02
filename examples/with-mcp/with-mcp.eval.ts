import { defineEnvironment, evaluate, expect } from 'reeval'

// The package in ./project and the releases MCP server, which the agent starts in the sandbox.
const app = defineEnvironment('acme-cli', ({ directory, file, mcp }) => ({
  files: { ...directory('./project'), 'mcp/releases.mjs': file('./mcp/releases.mjs') },
  mcp: { releases: mcp.stdio('node', ['mcp/releases.mjs']) },
}))

evaluate('bumps to the latest release', { environments: app }, async (c) => {
  const turn = await c.send(
    "Set package.json's version to the latest acme-cli release. " +
      "The releases MCP server's latest_version tool knows it.",
  )

  expect(turn).toHaveCalledMcp('releases', 'latest_version')
  await expect(turn).toHaveFile('package.json', /"version": "2\.4\.0"/)
})
