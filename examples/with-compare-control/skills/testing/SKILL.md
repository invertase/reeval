---
name: testing
description: How this project tests its code. Use whenever you add or change a function in src/.
---

# Testing

Every function exported from `src/math.js` has a test in `test/math.test.js`, written with
`node:test` and `node:assert/strict`. When you add a function, add its test in the same change:

```js
test('multiply', () => {
  assert.equal(multiply(2, 3), 6)
})
```

Run `node --test` before you finish.
