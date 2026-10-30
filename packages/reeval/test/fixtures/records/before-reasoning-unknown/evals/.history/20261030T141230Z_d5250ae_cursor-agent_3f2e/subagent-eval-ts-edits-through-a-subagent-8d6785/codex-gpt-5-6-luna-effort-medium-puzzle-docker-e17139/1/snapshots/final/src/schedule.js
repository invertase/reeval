// Returns the number of meetings that can be attended without overlap.
export function maxMeetings(meetings) {
  let lastEnd = -Infinity
  let attended = 0

  const byEndTime = [...meetings].sort((first, second) => first[1] - second[1])

  for (const [start, end] of byEndTime) {
    if (start >= lastEnd) {
      attended += 1
      lastEnd = end
    }
  }

  return attended
}
