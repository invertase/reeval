import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({ harness: fakeHarness(), sandbox: docker() })
