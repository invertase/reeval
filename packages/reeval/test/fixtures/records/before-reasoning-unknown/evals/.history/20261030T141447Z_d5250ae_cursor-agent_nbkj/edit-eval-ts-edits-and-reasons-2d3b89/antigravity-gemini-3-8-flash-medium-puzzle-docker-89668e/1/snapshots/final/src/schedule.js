// Returns the number of meetings that can be attended without overlap.
export function maxMeetings(meetings) {
  if (!meetings || meetings.length === 0) {
    return 0
  }

  const sorted = [...meetings].sort((a, b) => a[1] - b[1])
  let count = 0
  let lastEnd = -Infinity

  for (const [start, end] of sorted) {
    if (start >= lastEnd) {
      count++
      lastEnd = end
    }
  }

  return count
}
