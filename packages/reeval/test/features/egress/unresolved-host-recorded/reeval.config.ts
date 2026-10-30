import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox can't record egress.
export default defineConfig({
  // As the agent: a name that never resolves (`.invalid`, RFC 6761), as a CLI probing GCP's
  // metadata server outside GCP does, then the link-local metadata address the policy refuses.
  // Plain HTTP, so each refusal's body is the output.
  harness: fakeHarness({
    script: [
      [
        { exec: 'curl -sS -m 10 http://reeval-missing.invalid/' },
        { exec: 'curl -sS -m 10 http://169.254.169.254/' },
      ],
    ],
  }),
})
