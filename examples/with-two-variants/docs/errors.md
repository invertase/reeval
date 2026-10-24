# Errors

A function never returns `Infinity`, `NaN` or `undefined` for an argument it can't handle. It
throws a `RangeError` whose message names the argument and says what it must be:

```js
if (b === 0) throw new RangeError('b must not be 0')
```
