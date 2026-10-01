import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'

const gemini = defineEnvironment('gemini', ({ secret }) => ({
  env: { GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', { hosts: secret.hosts.gemini }) },
}))

// The variant is its own environment: it brokers the key the control holds in the clear.
const plain = defineEnvironment('plain', ({ secret }) => ({ env: { API_KEY: secret() } }))
const brokered = defineEnvironment('brokered', ({ secret }) => ({
  env: {
    API_KEY: secret({ hosts: ['api.example.com', '*.example.org'], in: ['header', 'query'] }),
  },
}))

const docs = defineEnvironment('docs', ({ mcp, secret }) => ({
  mcp: {
    remote: mcp.http('https://mcp.example.com/v1', { headers: { 'x-api-key': secret() } }),
    local: mcp.http('http://localhost:3333', {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
      headers: { authorization: secret.template('Bearer ${LOCAL_TOKEN}') },
    }),
  },
}))

evaluate('a preset host', { environment: gemini }, async () => {})
evaluate(
  'a variant brokers it',
  { compare: { baseline: plain, variants: [brokered] } },
  async () => {},
)
evaluate('MCP headers go to their server', { environment: docs }, async () => {})
evaluate(
  'the fake sandbox gets placeholders too, and no warning',
  { environment: gemini.extend('gemini-fake', { sandbox: fakeSandbox() }) },
  async () => {},
)
