// Returns the number of meetings that can be attended without overlap.
export function maxMeetings(meetings) {
  if (meetings.length === 0) return 0
  const sorted = [...meetings].sort((a, b) => a[1] - b[1])
  let count = 1
  let lastEnd = sorted[0][1]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] >= lastEnd) {
      count++
      lastEnd = sorted[i][1]
    }
  }
  return count
}
