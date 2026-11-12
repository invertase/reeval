import { evaluate, expect } from 'reeval'
import { LOG, probed, probedLines, prompt } from './env.ts'

// fx's stdio MCP server has the eval's variable, the secret's placeholder and the egress
// gateway: its fetch of the allowed listener got through.
evaluate('lands', { environments: probed }, async (c) => {
  await c.send(prompt)
  expect(probedLines(await c.readFile(LOG))).toEqual([
    'word=HERON-41',
    'key=placeholder',
    'fetched=reeval-egress-ok',
  ])
})
