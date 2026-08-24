'use strict';
// Labai paprasta failinė duomenų bazė (JSON failas), pakankama nedideliam
// komandos naudojimui. Rašymai serializuojami per eilę (withDb), kad
// vienu metu vykstantys keli užklausimai vienas kito neperrašytų.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], events: [], vehicles: [], templates: [] }, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) data.users = [];
    if (!Array.isArray(data.events)) data.events = [];
    if (!Array.isArray(data.vehicles)) data.vehicles = [];
    // Darbų šablonai (pvz. "Audi A6 grandinės keitimas") — senesnėse
    // duomenų bazėse šio lauko dar nėra, tad numatytoji reikšmė — tuščias
    // sąrašas, kad nereikėtų atskiros migracijos.
    if (!Array.isArray(data.templates)) data.templates = [];
    return data;
  } catch (e) {
    console.error('[DB] Nepavyko nuskaityti', DB_FILE, '- naudojama tuščia duomenų bazė.', e.message);
    return { users: [], events: [], vehicles: [], templates: [] };
  }
}

function writeDb(data) {
  ensureDb();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// Serializuota "skaityti - pakeisti - įrašyti" operacija.
// fn(data) gali mutuoti `data` tiesiogiai ir/arba grąžinti reikšmę.
let chain = Promise.resolve();
function withDb(fn) {
  const p = chain.then(async () => {
    const data = readDb();
    const result = await fn(data);
    writeDb(data);
    return result;
  });
  chain = p.catch(() => {});
  return p;
}

module.exports = { readDb, writeDb, withDb, ensureDb, DATA_DIR, DB_FILE };
