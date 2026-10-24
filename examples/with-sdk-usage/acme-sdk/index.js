export class AcmeError extends Error {
  constructor(status) {
    super(`Acme API answered ${status}`)
    this.status = status
    this.retryable = status === 429 || status >= 500
  }
}

export function createClient({ apiKey }) {
  if (!apiKey) throw new Error('createClient: apiKey is required')

  async function weather(city) {
    const url = `https://api.acme.test/v1/weather?city=${encodeURIComponent(city)}`
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } })
    if (!res.ok) throw new AcmeError(res.status)
    return res.json()
  }

  async function retry(call, { attempts = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call()
      } catch (error) {
        if (!error.retryable || attempt >= attempts) throw error
      }
    }
  }

  return { weather, retry }
}
