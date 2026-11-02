import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const [host, port] = (process.env.REEVAL_EGRESS_TARGET ?? ':').split(':')

// Docker only: the fake sandbox runs commands on the host, with its network.
export default defineConfig({
  // As the agent: a raw TCP connection to the host's listener, as a database driver or SSH makes
  // one, which no proxy variable routes through the gateway.
  harnesses: fakeHarness({
    script: [
      [
        {
          exec: `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port} && printf "GET / HTTP/1.0\\r\\n\\r\\n" >&3 && tail -n 1 <&3' 2>&1; echo " exit=$?"`,
        },
      ],
    ],
  }),
})
