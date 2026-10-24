---
name: api-conventions
description: How this project's list functions page their results. Use whenever you write or change a function that returns a list.
---

# API conventions

A list function returns one page at a time and pages by cursor, never by offset.

- It takes `{ cursor, limit }`. No `cursor` means the first page; `limit` defaults to 10.
- It returns `{ data, nextCursor }`: `data` is the page, and `nextCursor` is the id of the last
  item on it, or `null` on the last page.

```js
listUsers({ limit: 2 }) // { data: [u1, u2], nextCursor: 'u2' }
listUsers({ cursor: 'u2', limit: 2 }) // { data: [u3, u4], nextCursor: 'u4' }
```
