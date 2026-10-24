import { createClient } from '../vendor/acme/index.js'

export async function forecast(city) {
  const client = createClient({ apiKey: process.env.ACME_API_KEY })
  const { tempC } = await client.retry(() => client.weather(city))
  return tempC
}
