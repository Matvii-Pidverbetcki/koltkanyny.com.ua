'use strict';
const crypto = require('node:crypto');
const hashPassword = pw => { const salt = crypto.randomBytes(16); return `s1$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
const verifyPassword = (pw, stored) => {
  const [v, s, hsh] = String(stored || 's1$00$00').split('$');
  let a; try { a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); } catch { return false; }
  const b = Buffer.from(hsh, 'hex'); return v === 's1' && a.length === b.length && crypto.timingSafeEqual(a, b);
};
module.exports = { hashPassword, verifyPassword };
