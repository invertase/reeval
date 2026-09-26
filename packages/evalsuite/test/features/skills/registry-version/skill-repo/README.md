The GitHub repository `acme/skills` this fixture's registry id names. `features.test.ts` turns
it into a git repository at `registry/acme/skills.git` before the run (`v1/` committed and tagged
`v1`, then `v2/` committed on `main`) and points `https://github.com/` there with git's
`url.<base>.insteadOf`, so `skill.registry` clones it without the network.
