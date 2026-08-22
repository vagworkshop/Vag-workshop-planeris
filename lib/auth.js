'use strict';
const crypto = require('crypto');
const ACCOUNTS = require('./accounts');
const { readDb, writeDb } = require('./db');
const { hashPassword, verifyPassword, signSession, verifySession } = require('./security');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dienų

let warnedNoSecret = false;
let tmpSecret = null;
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!warnedNoSecret) {
    console.warn('[ĮSPĖJIMAS] Aplinkos kintamasis JWT_SECRET nenustatytas — naudojamas laikinas atsitiktinis raktas. ' +
      'Po kiekvieno serverio perkrovimo visi turės prisijungti iš naujo. Nustatykite JWT_SECRET diegimo aplinkoje.');
    warnedNoSecret = true;
  }
  if (!tmpSecret) tmpSecret = crypto.randomBytes(32).toString('hex');
  return tmpSecret;
}

function genPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

// Sukuria pradinius vartotojus (jei jų dar nėra) prie serverio starto.
// Slaptažodis paimamas iš aplinkos kintamojo <VARDAS>_PASSWORD (pvz. ALANAS_PASSWORD),
// o jei jo nėra - sugeneruojamas atsitiktinis ir vieną kartą atspausdinamas į log'us.
function seedUsers() {
  const db = readDb();
  let changed = false;
  ACCOUNTS.forEach(acc => {
    const exists = db.users.find(u => u.username === acc.id);
    if (exists) {
      // Jei paskyra jau egzistuoja (buvo sukurta prieš pridedant rolę/keltuvų
      // ribojimą), vis tiek atnaujiname rolę ir leidžiamus keltuvus, kad
      // pasikeitimai (pvz. Alanui priskirti 2 keltuvai) įsigaliotų iškart.
      if (exists.role !== acc.role || JSON.stringify(exists.lifts) !== JSON.stringify(acc.lifts)) {
        exists.role = acc.role;
        exists.lifts = acc.lifts;
        changed = true;
      }
      return;
    }
    const envVar = acc.id.toUpperCase() + '_PASSWORD';
    const fromEnv = process.env[envVar];
    const pass = fromEnv || genPassword();
    db.users.push({
      id: crypto.randomUUID(),
      username: acc.id,
      displayName: acc.label,
      empId: acc.role === 'employee' ? acc.id : null,
      role: acc.role,
      lifts: acc.lifts,
      passwordHash: hashPassword(pass),
    });
    changed = true;
    if (fromEnv) {
      console.log(`[PIRMAS PALEIDIMAS] Sukurtas vartotojas "${acc.id}" su slaptažodžiu iš ${envVar}.`);
    } else {
      console.log(`[PIRMAS PALEIDIMAS] Sukurtas vartotojas "${acc.id}" su slaptažodžiu: ${pass}  <- IŠSISAUGOKITE, daugiau nebus rodomas. ` +
        `Vėliau galite pakeisti su: npm run set-password ${acc.id} <naujas_slaptazodis>`);
    }
  });
  if (changed) writeDb(db);
}

function verifyLogin(username, password) {
  const db = readDb();
  const user = db.users.find(u => u.username === (username || '').trim().toLowerCase());
  if (!user) return null;
  if (!password || !verifyPassword(password, user.passwordHash)) return null;
  return user;
}

function signToken(user) {
  const payload = {
    sub: user.id,
    username: user.username,
    displayName: user.displayName,
    empId: user.empId,
    role: user.role || 'employee',
    lifts: user.lifts !== undefined ? user.lifts : null,
    exp: Date.now() + SESSION_MAX_AGE_MS,
  };
  return signSession(payload, getSecret());
}

// Grąžina vartotojo payload'ą iš galiojančio žetono arba null.
function verifyToken(token) {
  return verifySession(token, getSecret());
}

module.exports = { ACCOUNTS, seedUsers, verifyLogin, signToken, verifyToken, SESSION_MAX_AGE_MS };
