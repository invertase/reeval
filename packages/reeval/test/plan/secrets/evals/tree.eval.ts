import { declareTree } from 'reeval/testing'

// Another language's declaration tree: its MCP headers are plain data.
declareTree(
  [
    {
      type: 'eval',
      name: 'a plain header from a declaration tree',
      mode: 'run',
      options: {
        environment: {
          kind: 'environment',
          name: 'tree-headers',
          layers: [
            {
              name: 'tree-headers',
              spec: {
                mcp: {
                  docs: {
                    kind: 'mcp',
                    transport: 'http',
                    url: 'https://docs.example.com/mcp',
                    headers: { 'X-Api-Key': 'tree-plain-value-1234' },
                  },
                },
              },
            },
          ],
        },
      },
      body: 'b1',
      source: { body: '0'.repeat(64) },
    },
  ] as never,
  () => async () => {},
)
