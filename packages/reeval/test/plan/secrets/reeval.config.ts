import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const session = defineEnvironment('session', ({ mcp }) => ({
  mcp: { app: mcp.http('https://app.example.com/mcp', { headers: { Cookie: 'sid=s3ss10n' } }) },
}))

export default defineConfig({
  harness: fakeHarness(),
  profiles: { headers: { defaults: { environment: session } } },
})
