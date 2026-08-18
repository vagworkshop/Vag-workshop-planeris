#!/usr/bin/env node
'use strict';
// Naudojimas: npm run set-password -- <vartotojo_vardas> <naujas_slaptazodis>
// arba:       node scripts/set-password.js <vartotojo_vardas> <naujas_slaptazodis>

const { readDb, writeDb } = require('../lib/db');
const { hashPassword } = require('../lib/security');

const args = process.argv.slice(2);
const [username, newPassword] = args;

if (!username || !newPassword) {
  console.log('Naudojimas: npm run set-password -- <vartotojo_vardas> <naujas_slaptazodis>');
  process.exit(1);
}

const db = readDb();
const user = db.users.find(u => u.username === username.trim().toLowerCase());
if (!user) {
  console.log('Vartotojas nerastas:', username);
  console.log('Žinomi vartotojai:', db.users.map(u => u.username).join(', ') || '(nėra)');
  process.exit(1);
}

user.passwordHash = hashPassword(newPassword);
writeDb(db);
console.log(`Slaptažodis atnaujintas vartotojui "${user.username}".`);
