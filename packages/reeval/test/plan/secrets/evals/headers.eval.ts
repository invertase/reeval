import { defineEnvironment, evaluate } from 'reeval'

const plain = defineEnvironment('plain-headers', ({ mcp, secret }) => ({
  mcp: {
    local: mcp.http('http://localhost:4000/mcp', {
      headers: {
        Authorization: 'Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0',
        'X-Trace': 'ghp_0123456789abcdefghijABCDEFGHIJ0123456789',
        'X-Request-Source': 'reeval',
      },
    }),
    remote: mcp.http('https://mcp.example.com/v1', {
      headers: {
        'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
        Authorization: secret.template('Bearer ${MCP_TOKEN}'),
      },
    }),
  },
}))

evaluate('plain MCP headers that look like credentials', { environment: plain }, async () => {})
evaluate('a header from the profile environment', async () => {})
