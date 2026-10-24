// Calls forecast() against a stand-in for the Acme API that answers 503 once, then the weather.
import assert from 'node:assert/strict'

const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), authorization: init?.headers?.authorization })
  if (requests.length === 1) return new Response('busy', { status: 503 })
  return Response.json({ city: 'Lisbon', tempC: 18 })
}
process.env.ACME_API_KEY = 'test-key'

const { forecast } = await import('./src/forecast.js')
assert.equal(await forecast('Lisbon'), 18, 'forecast("Lisbon") resolves to the temperature')
assert.equal(requests.length, 2, 'the 503 is retried once')
assert.match(requests[1].url, /^https:\/\/api\.acme\.test\/v1\/weather\?city=Lisbon$/)
assert.equal(requests[1].authorization, 'Bearer test-key', 'the key comes from ACME_API_KEY')
console.log('forecast() retries the 503 and returns 18')
