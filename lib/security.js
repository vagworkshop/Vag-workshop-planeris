'use strict';
// Slaptažodžių maišymas ir pasirašyti prisijungimo "žetonai" (mini-JWT),
// realizuoti naudojant TIK Node.js integruotą "crypto" modulį - jokių
// išorinių paketų (bcrypt/jsonwebtoken) nereikia diegti.

const crypto = require('crypto');

/* ── SLAPTAŽODŽIAI (scrypt) ── */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  let hash;
  try {
    hash = crypto.scryptSync(String(password), salt, 64);
  } catch (e) {
    return false;
  }
  const storedHash = Buffer.from(hashHex, 'hex');
  if (storedHash.length !== hash.length) return false;
  return crypto.timingSafeEqual(hash, storedHash);
}

/* ── PASIRAŠYTI SESIJOS ŽETONAI (HMAC-SHA256, panašu į JWT) ── */
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function signSession(payload, secret) {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

function verifySession(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!body || !sig) return null;

  const expectedSig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

module.exports = { hashPassword, verifyPassword, signSession, verifySession };
