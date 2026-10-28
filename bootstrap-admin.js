'use strict';
// Створює першого адміна при старті, ЛИШЕ якщо в базі ще немає жодного адміна
// і задано змінні ADMIN_EMAIL та ADMIN_PASSWORD (мін. 12 символів). Інакше нічого не робить.
const { db } = require('../db');
const { hashPassword } = require('../auth');
const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
if (email && pw && !db.prepare('SELECT 1 FROM admins LIMIT 1').get()) {
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 12) console.error('ADMIN_EMAIL/ADMIN_PASSWORD некоректні (пароль ≥ 12 символів) — адміна не створено.');
  else { db.prepare("INSERT INTO admins(email,pass_hash,role) VALUES(?,?, 'super')").run(email, hashPassword(pw)); console.log('Створено першого адміна:', email); }
}
