---
name: release
description: How to prepare a release of this project. Use when asked to release, or to bump the version.
---

# Release

1. Ask the `releases` MCP server's `next_version` tool for the version to release.
2. Set `version` in `package.json` to it.
3. In `CHANGELOG.md`, rename the `## Unreleased` heading to `## <version>`, keeping its lines.
