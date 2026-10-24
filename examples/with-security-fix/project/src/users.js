import { DatabaseSync } from 'node:sqlite'

export function openDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO users (name, email) VALUES
      ('Ada', 'ada@example.com'),
      ('Grace', 'grace@example.com'),
      ('Miles O''Brien', 'miles@example.com');
  `)
  return db
}

export function findUser(db, name) {
  return db.prepare(`SELECT id, name, email FROM users WHERE name = '${name}'`).all()
}
