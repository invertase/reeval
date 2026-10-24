# Acme SDK

```js
import { createClient } from './vendor/acme/index.js'

const client = createClient({ apiKey: process.env.ACME_API_KEY })
const { tempC } = await client.retry(() => client.weather('Lisbon'))
```

- `createClient({ apiKey })` makes a client. The key is required.
- `client.weather(city)` resolves to `{ city, tempC }`. It rejects with an `AcmeError` when the API
  answers an error; `error.retryable` is `true` for `429` and `5xx`.
- `client.retry(call, { attempts = 3 })` calls `call` again while it rejects with a retryable
  error, up to `attempts` times. Use it rather than your own loop.
