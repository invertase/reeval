## Turn 1

> Create greet.js exporting greet(name) that returns "Hello, <name>!". No dependencies.

Created `greet.js` with a `greet(name)` export that returns `"Hello, <name>!"`:

```javascript
function greet(name) {
  return `Hello, ${name}!`;
}

module.exports = { greet };
```

Verified: `greet('World')` returns `Hello, World!`.

## Turn 2

> Make name default to "world" when greet() is called without arguments.

`greet()` now defaults `name` to `"world"`:

```javascript
function greet(name = "world") {
  return `Hello, ${name}!`;
}
```

- `greet()` → `"Hello, world!"`
- `greet('Alice')` → `"Hello, Alice!"`
