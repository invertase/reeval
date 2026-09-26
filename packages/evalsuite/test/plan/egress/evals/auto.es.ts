import { defineEnvironment, evaluate } from 'evalsuite'

// A restricted policy allows what the environment itself sends traffic to.
const services = defineEnvironment('services', ({ mcp, secret }) => ({
  egress: 'deny-all',
  env: { GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', { hosts: secret.hosts.gemini }) },
  mcp: {
    docs: mcp.http('https://mcp.example.com/v1', { headers: { 'x-api-key': secret() } }),
    local: mcp.stdio('node', ['server.js']),
  },
}))
const listed = defineEnvironment('listed', ({ secret }) => ({
  egress: { allow: ['api.example.com'] },
  env: { API_KEY: secret({ hosts: ['api.example.com', 'uploads.example.com'] }) },
}))

evaluate('secret and MCP hosts are allowed', { environment: services }, async () => {})
evaluate('hosts the policy lists are not repeated', { environment: listed }, async () => {})
