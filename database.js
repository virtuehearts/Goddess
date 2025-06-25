const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'goddess.db'));

function init() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT,
      age INTEGER,
      gender TEXT,
      location TEXT,
      personality TEXT,
      hobbies TEXT,
      movies TEXT,
      music TEXT,
      likes TEXT,
      work TEXT,
      religion TEXT,
      past TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      is_user INTEGER,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      task TEXT,
      completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    const cols = ['gender','location','personality','hobbies','movies','music'];
    cols.forEach(c => {
      db.run(`ALTER TABLE users ADD COLUMN ${c} TEXT`, () => {});
    });
  });
}

function seedAdmin(email, password) {
  if (!email || !password) return;
  db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => {
    if (err) return console.error(err);
    if (!row) {
      bcrypt.hash(password, 10, (err, hash) => {
        if (err) return console.error(err);
        db.run('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', [email, hash, 'Admin']);
      });
    }
  });
}

module.exports = { db, init, seedAdmin };
