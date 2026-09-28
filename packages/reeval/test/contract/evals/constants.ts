// The contract's constants, without imports, so contract.test.ts can read them too.

/** Only the placed skill knows it: the agent can write it only after reading the skill. */
export const SKILL_PROOF = 'PROBE-7F3K-QUILL'
/** Only the rules know it. */
export const RULES_WORD = 'TANGERINE-41'
/** What the command in the edit-and-run prompt prints; the agent must run it to see it. */
export const COMMAND = 'echo contract-$((6*7))'
export const COMMAND_OUTPUT = 'contract-42'
/** The stdio MCP server logs every request here, outside the workspace. */
export const MCP_LOG = '/tmp/reeval-mcp-stamp.log'
/** A host the deny-all policy refuses; the curl's CONNECT status lands in blocked.txt. */
export const BLOCKED_HOST = 'example.com'
export const reach = (host: string) =>
  `curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://${host}/ > blocked.txt`
/** Planted in the canary's environment and home, so the key scanner has something to find. */
export const PLANTED = 'contract-planted-9d2e5f01a7c3b846'
