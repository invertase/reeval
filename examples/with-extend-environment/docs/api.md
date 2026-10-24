# API conventions

Every function in `src/` checks its arguments: when one isn't a number, it throws a `TypeError`
naming the argument.

```js
if (typeof a !== 'number') throw new TypeError('a must be a number')
```
