'use strict';
// Використання: npm run create-admin -- email@example.com [super|manager|editor]
// Пароль вводиться інтерактивно (не потрапляє в історію shell) або береться з ADMIN_PASSWORD.
const readline = require('node:readline');
const { db } = require('../db');
const { hashPassword } = require('../auth');
const [email, role = 'super'] = process.argv.slice(2);
if (!email || !/^\S+@\S+\.\S+$/.test(email) || !['super', 'manager', 'editor'].includes(role)) {
  console.error('Використання: npm run create-admin -- email@example.com [super|manager|editor]'); process.exit(1);
}
function ask(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a); });
  });
}
(async () => {
  const pw = process.env.ADMIN_PASSWORD || await ask('Пароль (мін. 12 символів): ');
  if (pw.length < 12) { console.error('Пароль закороткий.'); process.exit(1); }
  db.prepare('INSERT INTO admins(email,pass_hash,role) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET pass_hash=excluded.pass_hash, role=excluded.role')
    .run(email.toLowerCase(), hashPassword(pw), role);
  console.log(`Адміністратора ${email} (${role}) збережено.`);
})();
