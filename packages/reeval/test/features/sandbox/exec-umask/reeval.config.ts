import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker and Podman only: the fake sandbox runs on the host, with the host's umask.
export default defineConfig({
  // As the agent: a directory and a file from a command, and a file from its write tool.
  harnesses: fakeHarness({
    script: [
      [{ exec: 'mkdir -p made && touch made/by-agent' }, { write: { 'notes/today.md': 'hi\n' } }],
    ],
  }),
})
