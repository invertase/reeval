import { loadUsers } from './users.js'

console.log(loadUsers().filter((user) => user.active).length)
