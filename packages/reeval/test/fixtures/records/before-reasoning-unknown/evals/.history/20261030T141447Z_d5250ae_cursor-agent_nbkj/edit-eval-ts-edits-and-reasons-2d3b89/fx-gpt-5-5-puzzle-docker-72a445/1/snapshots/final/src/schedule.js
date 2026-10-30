// Returns the number of meetings that can be attended without overlap.
export function maxMeetings(meetings) {
  const sortedByEnd = [...meetings].sort((a, b) => a[1] - b[1])
  let count = 0
  let lastEnd = -Infinity

  for (const [start, end] of sortedByEnd) {
    if (start >= lastEnd) {
      count += 1
      lastEnd = end
    }
  }

  return count
}
