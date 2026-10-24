const names = ['Ada', 'Grace', 'Alan', 'Barbara', 'Edsger', 'Frances', 'Ken', 'Margaret', 'Tim']

// 45 users, sorted by id: u_001 to u_045.
export const users = Array.from({ length: 45 }, (_, i) => ({
  id: `u_${String(i + 1).padStart(3, '0')}`,
  name: `${names[i % names.length]} ${Math.floor(i / names.length) + 1}`,
}))
