import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const target = `http://${process.env.REEVAL_EGRESS_TARGET}/`

/** A UDP DNS query to the host's DNS server; exits 0 only on its answer. */
const askHostDns = `const r = new (require('dns').promises.Resolver)({ timeout: 2000, tries: 2 }); r.setServers([process.argv[1]]); r.resolve4('reeval.test').then((a) => process.exit(a[0] === process.argv[2] ? 0 : 1), () => process.exit(1))`

// Docker only: the fake sandbox can't enforce a policy, so reeval run would exit 2.
export default defineConfig({
  // As the agent: reach the host's listener directly, around the proxy, resolve a name in the
  // sandbox (through its own resolver, or else from the host's DNS server), then reach the
  // listener through the proxy.
  harnesses: fakeHarness({
    script: [
      [
        {
          exec: `curl -s -m 5 -o /dev/null -w '%{http_code}' --noproxy '*' ${target}; echo " exit=$?"`,
        },
        {
          exec: `getent hosts example.com >/dev/null || node -e "${askHostDns}" ${process.env.REEVAL_EGRESS_DNS} ${process.env.REEVAL_EGRESS_DNS_ANSWER} 2>/dev/null; echo "dns=$?"`,
        },
        { exec: `curl -sS -m 10 ${target}` },
      ],
    ],
  }),
})
