---
name: project-layout
description: Where things are in this package and how to check a change. Use before you add or change any code here.
---

# Project layout

- Every function lives in `src/math.js`, as a named export.
- Its tests live in `test/math.test.js`, one `test()` per function, with `node:assert/strict`.
- `node --test` runs them. There are no dependencies to install and no build step.

You don't need to explore the repository: add the function and its test, then run `node --test`.
