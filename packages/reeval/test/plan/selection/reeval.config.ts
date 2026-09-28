import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'

export default defineConfig({ harness: fakeHarness({}), sandbox: fakeSandbox() })
