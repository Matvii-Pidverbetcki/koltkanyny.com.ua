'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), path = require('node:path');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'shop.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP)');
const dir = path.join(__dirname, 'migrations');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(f)) continue;
  db.exec('BEGIN');
  try { db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(f); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
module.exports = { db, DATA };
