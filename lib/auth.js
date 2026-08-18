'use strict';
const crypto = require('crypto');
const EMPLOYEES = require('./employees');
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
  EMPLOYEES.forEach(emp => {
    const exists = db.users.find(u => u.username === emp.id);
    if (exists) return;
    const envVar = emp.id.toUpperCase() + '_PASSWORD';
    const fromEnv = process.env[envVar];
    const pass = fromEnv || genPassword();
    db.users.push({
      id: crypto.randomUUID(),
      username: emp.id,
      displayName: emp.label,
      empId: emp.id,
      passwordHash: hashPassword(pass),
    });
    changed = true;
    if (fromEnv) {
      console.log(`[PIRMAS PALEIDIMAS] Sukurtas vartotojas "${emp.id}" su slaptažodžiu iš ${envVar}.`);
    } else {
      console.log(`[PIRMAS PALEIDIMAS] Sukurtas vartotojas "${emp.id}" su slaptažodžiu: ${pass}  <- IŠSISAUGOKITE, daugiau nebus rodomas. ` +
        `Vėliau galite pakeisti su: npm run set-password ${emp.id} <naujas_slaptazodis>`);
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
    exp: Date.now() + SESSION_MAX_AGE_MS,
  };
  return signSession(payload, getSecret());
}

// Grąžina vartotojo payload'ą iš galiojančio žetono arba null.
function verifyToken(token) {
  return verifySession(token, getSecret());
}

module.exports = { EMPLOYEES, seedUsers, verifyLogin, signToken, verifyToken, SESSION_MAX_AGE_MS };
