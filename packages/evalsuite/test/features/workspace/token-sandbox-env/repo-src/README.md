The repository this fixture fetches over HTTP with a token. `features.test.ts` turns it into a
git repository at `repo/` before the run (`v1/` committed and tagged `v1`, then `v2/` on
`main`) and serves it, answering 401 to a request without the token.
