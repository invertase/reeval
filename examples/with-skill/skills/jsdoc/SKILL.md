---
name: jsdoc
description: How this project documents its code. Use whenever you add or change an exported function.
---

# JSDoc

Every exported function has a JSDoc comment right above it: one line saying what it does, a
`@param` for each argument and a `@returns`.

```js
/**
 * Adds two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function add(a, b) {
  return a + b
}
```
