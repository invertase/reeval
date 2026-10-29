// Preloaded (`node --import`) into a CLI whose Cursor catalog read must stay offline: everything
// no-network.mjs refuses stays refused, but `GET https://api.cursor.com/v1/models` answers with
// the items in $REEVAL_TEST_CURSOR_CATALOG (a JSON file), logged to $REEVAL_TEST_NETWORK_LOG.

import { appendFileSync, readFileSync } from 'node:fs'
import './no-network.mjs'

const refuse = globalThis.fetch
globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://api.cursor.com/v1/models') return refuse(input, init)
  if (process.env.REEVAL_TEST_NETWORK_LOG)
    appendFileSync(process.env.REEVAL_TEST_NETWORK_LOG, `catalog ${input}\n`)
  const items = JSON.parse(readFileSync(process.env.REEVAL_TEST_CURSOR_CATALOG, 'utf8'))
  return new Response(JSON.stringify({ items }), { status: 200 })
}
