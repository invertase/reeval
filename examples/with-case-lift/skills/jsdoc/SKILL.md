---
name: jsdoc
description: How this project documents its functions. Use whenever you add or change an exported function.
---

# JSDoc

Every function you add or change gets a JSDoc block right above it: one line on what it does,
then `@param` for each argument and `@returns`.

```js
/**
 * Adds two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number} a plus b
 */
export function add(a, b) {
  return a + b
}
```
