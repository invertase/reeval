One bug, in `src/page.js`:

- `page()` is off by one. Pages count from 1, but `start = number * size` treats them as counting
  from 0, so page 1 skips the first ten items and `search()` never returns its first ten matches.
  It should be `(number - 1) * size`.

`pageCount()` and `search()` look right otherwise. I haven't changed any files.
