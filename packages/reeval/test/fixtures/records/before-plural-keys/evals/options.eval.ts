import { defineEnvironment, evaluate, expect, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const app = defineEnvironment('app', {})

// The options #745 renamed, set on a group and an eval.
group('renamed options', { harness: fakeHarness(), pin: ['harness'] }, () => {
  evaluate('writes greet.js', { environment: app }, async (c) => {
    await c.send('Write greet.js.')
    await expect(c).toHaveFile('greet.js')
  })
})
