import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  // The agent writes its source, runs a build and leaves a minified vendor bundle behind.
  harness: fakeHarness({
    files: {
      'src/app.ts': 'export const app = () => "hello"\n',
      'dist/assets/index-a1b2c3.js': 'var bundle=function(){return"hello"};\n',
      'public/vendor.js': `!function(){${'var x=1;'.repeat(200)}}();\n`,
    },
  }),
  judge: { model: fakeJudge({ score: 1 }) },
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
