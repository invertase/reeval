import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: boat({ attemptsPerMachine: 2 }) on the fake Boat API, both attempts at once on
// one machine, with a bootstrap longer than the agent's start may take. As the agent: who ran the
// bootstrap and for which home, who owns what it left, and who and where the agent is.
export default defineConfig({
  harnesses: fakeHarness({
    bootstrap: 'sleep 3; echo "$(id -un) $HOME" > installed',
    startTimeout: '2s',
    script: [[{ exec: 'cat ~/installed; stat -c %U ~/installed; id -un; echo ~' }]],
  }),
})
