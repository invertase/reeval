// Returns the number of meetings that can be attended without overlap.
export function maxMeetings(meetings) {
  const sortedMeetings = [...meetings].sort((a, b) => a[1] - b[1])
  let lastEnd = -Infinity
  let count = 0

  for (const [start, end] of sortedMeetings) {
    if (start >= lastEnd) {
      count += 1
      lastEnd = end
    }
  }

  return count
}
