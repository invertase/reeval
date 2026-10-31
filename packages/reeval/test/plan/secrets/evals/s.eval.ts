import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'

const gemini = defineEnvironment('gemini', ({ secret }) => ({
  env: { GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', { hosts: secret.hosts.gemini }) },
}))

// The variant is its own environments: it brokers the key the control holds in the clear.
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
      headers: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
        authorization: secret.template('Bearer ${LOCAL_TOKEN}'),
        // Plain HTTP is never swapped, so its hosts don't broker it.
        'x-api-key': secret.fromEnv('LOCAL_KEY', { hosts: ['localhost'] }),
      },
    }),
  },
}))

evaluate('a preset host', { environments: gemini }, async () => {})
evaluate(
  'a variant brokers it',
  { compare: { baseline: plain, variants: [brokered] } },
  async () => {},
)
evaluate('MCP headers go to their server', { environments: docs }, async () => {})
evaluate(
  'the fake sandbox gets placeholders too, and no warning',
  { environments: gemini.extend('gemini-fake', { sandbox: fakeSandbox() }) },
  async () => {},
)
