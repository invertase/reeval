# JSDoc tags

- `@param {type} name` for each argument, in order.
- `@returns {type} what it is`, unless the function returns nothing.
- `@throws {ErrorType} when`, for each error it throws on purpose.

```js
/**
 * Divides one number by another.
 * @param {number} a
 * @param {number} b
 * @returns {number} a divided by b
 * @throws {RangeError} when b is 0
 */
```
