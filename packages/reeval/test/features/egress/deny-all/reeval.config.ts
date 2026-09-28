import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

const target = `http://${process.env.REEVAL_EGRESS_TARGET}/`

// Docker only: the fake sandbox can't enforce a policy, so reeval run would exit 2.
export default defineConfig({
  // As the agent: reach the host's listener directly, around the proxy, resolve a name in the
  // sandbox, then reach the listener through the proxy.
  harness: fakeHarness({
    script: [
      [
        {
          exec: `curl -s -m 5 -o /dev/null -w '%{http_code}' --noproxy '*' ${target}; echo " exit=$?"`,
        },
        { exec: `getent hosts example.com >/dev/null; echo "dns=$?"` },
        { exec: `curl -sS -m 10 ${target}` },
      ],
    ],
  }),
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
