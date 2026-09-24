
import { defineConfig, fakeHarness, fakeSandbox } from 'evalsuite'
export default defineConfig({
  harness: fakeHarness({}),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
  judge: { fake: { verdict: 'pass', reason: 'looks fine', evidence: [] } },
  
})
