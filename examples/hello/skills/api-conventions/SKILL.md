---
name: api-conventions
description: This organisation's HTTP API conventions for list endpoints and errors. Use when adding or changing any API route, especially one that returns a list or an error.
---

# API conventions

Every HTTP API this organisation ships follows these rules. They are not the framework's
defaults, so apply them even where another shape would also work.

## List endpoints use cursor pagination

- Never paginate with `page`, `offset` or `skip`. Take two query parameters:
  - `limit`: how many items to return, a whole number from 1 to 100. Default 20.
  - `cursor`: where to continue from, exactly as the previous response's `nextCursor` gave it.
    Omit it for the first page.
- Respond `200` with exactly this body:

  ```json
  { "data": [ … ], "nextCursor": "…" }
  ```

  `data` holds the page's items, in a stable order (by `id`). `nextCursor` is the cursor for the
  next page, or `null` on the last page. Don't add `total`, `page` or `hasMore`.
- A cursor is opaque to clients: the last returned item's `id`, base64url-encoded. Decode it on
  the way in and continue after that `id`.

## Errors have one shape

- Every error response has this body, and no other fields:

  ```json
  { "error": { "code": "invalid_cursor", "message": "The cursor is not valid." } }
  ```

  `code` is a stable snake_case identifier; `message` is a sentence for a human.
- A `cursor` that doesn't decode, or names no item, is `400` with code `invalid_cursor`.
- A `limit` that isn't a whole number from 1 to 100 is `400` with code `invalid_limit`.

## Tests

Test every list endpoint through its route handler: the first page, following `nextCursor` to
the last page (where it's `null`), and each error code above.
