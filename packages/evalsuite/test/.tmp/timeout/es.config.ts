
import { defineConfig, fakeHarness, fakeSandbox } from 'evalsuite'
export default defineConfig({
  harness: fakeHarness({ delayMs: 60_000 }),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
  judge: { fake: { verdict: 'pass', reason: 'ok', evidence: ['e'] } },
  
})
