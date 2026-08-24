'use strict';
// AutoServisas Kalendorius — serveris.
// Sąmoningai parašytas naudojant TIK Node.js integruotus modulius (http, fs,
// path, crypto) — jokių "npm install" priklausomybių, todėl diegimas
// niekada nesugrius dėl paketų problemos ir veikia identiškai bet kurioje
// aplinkoje, kurioje yra Node.js.

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const { withDb, readDb, DATA_DIR } = require('./lib/db');
const { seedUsers, verifyLogin, signToken, verifyToken, SESSION_MAX_AGE_MS } = require('./lib/auth');
const { hashPassword, verifyPassword } = require('./lib/security');
const { validateEvent } = require('./lib/validate');
const { parseCookies, serializeCookie, readJsonBody, sendJson } = require('./lib/http-utils');
const { serveStatic } = require('./lib/static');

const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

seedUsers();

// Senesni įrašai buvo priskirti tiesiai darbuotojui (laukas "emp": alanas/
// sigitas/darius). Pridėjus keltuvus, kiekvienas įrašas dabar priklauso
// konkrečiam keltuvui (laukas "lift"). Ši funkcija vieną kartą serverio
// paleidimo metu automatiškai priskiria seniems įrašams numatytąjį keltuvą
// pagal buvusį darbuotoją — jokie įrašai neprapuola.
const LEGACY_EMP_TO_LIFT = { alanas: 'l1', sigitas: 'l3', darius: 'l4' };
function migrateEvents() {
  return withDb(db => {
    db.events.forEach(ev => {
      if (!ev.lift) {
        ev.lift = LEGACY_EMP_TO_LIFT[ev.emp] || 'l1';
      }
      delete ev.emp;
    });
  });
}

const ALLOWED_FIELDS = ['lift', 'client', 'car', 'plate', 'phone', 'mileage', 'dateFrom', 'dateTo', 'start', 'end', 'desc', 'status', 'statusNote', 'parts', 'workItems', 'partsDraft', 'notes', 'paid', 'paymentMethod', 'archived', 'showInJobs'];
const PAID_VALUES = ['no', 'yes'];
const PAYMENT_METHOD_VALUES = ['', 'sf', 'be_sf'];
// Darbe naudojami meistrai — "kas atliko darbą" laukas gali nurodyti bet
// kurį iš jų, nepriklausomai nuo to, kuriam keltuvui/meistrui darbas
// priskirtas pagal numatytuosius nustatymus (žr. index.html empForLift()).
const MECHANIC_IDS = ['alanas', 'sigitas', 'darius'];

// Dalys ir atlikti darbai — masyvai, saugomi kartu su darbo įrašu. Kiekvienas
// elementas griežtai apkarpomas iki žinomų laukų ir saugaus ilgio, kad
// klientas negalėtų įkišti savavalių papildomų laukų ar per didelių įrašų.
function sanitizeParts(arr) {
  if (!Array.isArray(arr)) return [];
  const s = v => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  return arr.slice(0, 300).map(p => ({
    id: (typeof p.id === 'string' && p.id) ? p.id.slice(0, 100) : crypto.randomUUID(),
    name: s(p.name),
    qty: s(p.qty).slice(0, 20),
    code: s(p.code).slice(0, 100),
    oeCode: s(p.oeCode).slice(0, 100),
    eta: s(p.eta).slice(0, 20),
    supplier: s(p.supplier),
    price: s(p.price).slice(0, 20),
    ordered: p.ordered === 'yes' ? 'yes' : 'no',
  })).filter(p => p.name || p.code || p.oeCode);
}
function sanitizeWorkItems(arr) {
  if (!Array.isArray(arr)) return [];
  const s = v => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
  return arr.slice(0, 300).map(w => ({
    id: (typeof w.id === 'string' && w.id) ? w.id.slice(0, 100) : crypto.randomUUID(),
    desc: s(w.desc),
    price: (typeof w.price === 'string' || typeof w.price === 'number') ? String(w.price).trim().slice(0, 20) : '',
    performedBy: MECHANIC_IDS.includes(w.performedBy) ? w.performedBy : '',
    date: (typeof w.date === 'string' ? w.date.trim().slice(0, 20) : ''),
  })).filter(w => w.desc);
}
function pickFields(body) {
  const out = {};
  ALLOWED_FIELDS.forEach(k => {
    if (body[k] !== undefined && body[k] !== null) {
      if (k === 'parts' || k === 'workItems' || k === 'partsDraft') {
        out[k] = body[k];
      } else if (k === 'archived' || k === 'showInJobs') {
        out[k] = !!body[k];
      } else {
        out[k] = typeof body[k] === 'string' ? body[k] : String(body[k]);
      }
    }
  });
  ['client', 'car', 'plate', 'phone', 'mileage', 'desc', 'notes', 'statusNote'].forEach(k => { if (typeof out[k] === 'string') out[k] = out[k].trim(); });
  if (typeof out.notes === 'string') out.notes = out.notes.slice(0, 5000);
  if (typeof out.mileage === 'string') out.mileage = out.mileage.slice(0, 30);
  if (typeof out.statusNote === 'string') out.statusNote = out.statusNote.slice(0, 200);
  if (out.paid !== undefined && !PAID_VALUES.includes(out.paid)) out.paid = 'no';
  if (out.paymentMethod !== undefined && !PAYMENT_METHOD_VALUES.includes(out.paymentMethod)) out.paymentMethod = '';
  if (out.parts !== undefined) out.parts = sanitizeParts(out.parts);
  if (out.workItems !== undefined) out.workItems = sanitizeWorkItems(out.workItems);
  // Juodraštis naudoja tą pačią lauko formą kaip ir dalys (pvz. galimybė
  // perkelti eilutę tarp abiejų sąrašų klientui iš karto veikiant).
  if (out.partsDraft !== undefined) out.partsDraft = sanitizeParts(out.partsDraft);
  return out;
}

/* ── AUTOMOBILIAI (atskira duomenų bazė, susieta su darbais per valst. nr.) ──
   Kai darbas (įrašas) sukuriamas arba redaguojamas su neutuščiu valstybiniu
   numeriu, automobilis automatiškai atsiranda šiame sąraše — BET tik jei jo
   dar nėra (esamo automobilio duomenų automatiškai neperrašome, kad
   nepradingtų rankiniu būdu suvesti/pataisyti duomenys ar nuotrauka). */
function normalizePlate(p) {
  return (typeof p === 'string' ? p.trim().toUpperCase() : '');
}
function upsertVehicleForPlate(db, data, username) {
  const plate = normalizePlate(data.plate);
  if (!plate) return;
  if (!Array.isArray(db.vehicles)) db.vehicles = [];
  const exists = db.vehicles.some(v => normalizePlate(v.plate) === plate);
  if (exists) return;
  db.vehicles.push({
    id: crypto.randomUUID(),
    plate,
    car: data.car || '',
    client: data.client || '',
    phone: data.phone || '',
    photoUrl: '',
    createdBy: username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

const VEHICLE_PHOTO_DIR = path.join(DATA_DIR, 'vehicle-photos');
const VEHICLE_PHOTO_MAX_BYTES = 4 * 1024 * 1024; // 4MB (po dekodavimo)
function saveVehiclePhoto(vehicleId, dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('Neteisingas nuotraukos formatas.');
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > VEHICLE_PHOTO_MAX_BYTES) throw new Error('Nuotrauka per didelė (maks. 4MB).');
  deleteVehiclePhotoFiles(vehicleId);
  if (!fs.existsSync(VEHICLE_PHOTO_DIR)) fs.mkdirSync(VEHICLE_PHOTO_DIR, { recursive: true });
  const filename = vehicleId + '.' + ext;
  fs.writeFileSync(path.join(VEHICLE_PHOTO_DIR, filename), buf);
  return '/vehicle-photos/' + filename;
}
function deleteVehiclePhotoFiles(vehicleId) {
  ['jpg', 'jpeg', 'png', 'webp'].forEach(ext => {
    const p = path.join(VEHICLE_PHOTO_DIR, vehicleId + '.' + ext);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* nesvarbu */ }
  });
}

function getAuthUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.token;
  if (!token) return null;
  return verifyToken(token); // null jei negalioja/pasibaigęs
}

// user.lifts === null/undefined reiškia "visi keltuvai" (savininkas, priėmėjas).
// Darbuotojo paskyra mato/tvarko tik jai priskirtus keltuvus.
function canAccessLift(user, liftId) {
  if (!user.lifts) return true;
  return user.lifts.includes(liftId);
}

// Darbuotojo (role: "employee") paskyra kalendorių tik stebi — kurti, redaguoti
// ar trinti darbus gali tik pilnos prieigos paskyros (savininkas, priėmėjas).
function isReadOnly(user) {
  return user.role === 'employee';
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', serializeCookie('token', token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PROD,
    maxAge: SESSION_MAX_AGE_MS,
  }));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie('token', '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PROD,
    maxAge: 0,
  }));
}

async function handleApi(req, res, pathname, method) {
  // /api/login
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const user = verifyLogin(body.username, body.password);
    if (!user) return sendJson(res, 401, { error: 'Neteisingas vartotojo vardas arba slaptažodis.' });
    setAuthCookie(res, signToken(user));
    return sendJson(res, 200, { user: { username: user.username, displayName: user.displayName, empId: user.empId } });
  }

  // /api/logout
  if (pathname === '/api/logout' && method === 'POST') {
    clearAuthCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // Viskas žemiau reikalauja prisijungimo
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Neprisijungta arba sesija baigėsi.' });

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { user: {
      username: user.username,
      displayName: user.displayName,
      empId: user.empId,
      role: user.role || 'employee',
      lifts: user.lifts !== undefined ? user.lifts : null,
    } });
  }

  if (pathname === '/api/change-password' && method === 'POST') {
    const body = await readJsonBody(req);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || !newPassword) {
      return sendJson(res, 400, { error: 'Užpildykite abu slaptažodžio laukus.' });
    }
    if (newPassword.length < 4) {
      return sendJson(res, 400, { error: 'Naujas slaptažodis per trumpas (bent 4 simboliai).' });
    }

    let errStatus = null, errMsg = null;
    await withDb(db => {
      const dbUser = db.users.find(u => u.username === user.username);
      if (!dbUser || !verifyPassword(currentPassword, dbUser.passwordHash)) {
        errStatus = 401; errMsg = 'Neteisingas dabartinis slaptažodis.'; return;
      }
      dbUser.passwordHash = hashPassword(newPassword);
    });
    if (errStatus) return sendJson(res, errStatus, { error: errMsg });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/events' && method === 'GET') {
    const db = readDb();
    const visible = user.lifts ? db.events.filter(e => user.lifts.includes(e.lift)) : db.events;
    return sendJson(res, 200, visible);
  }

  if (pathname === '/api/events' && method === 'POST') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite kurti darbų.' });
    }
    const body = await readJsonBody(req);
    const data = pickFields(body);
    if (!data.dateTo) data.dateTo = data.dateFrom;
    const errors = validateEvent(data);
    if (errors.length) return sendJson(res, 400, { error: errors.join(' ') });
    if (!canAccessLift(user, data.lift)) {
      return sendJson(res, 403, { error: 'Neturite teisės kurti darbų šiam keltuvui.' });
    }

    const ev = {
      id: crypto.randomUUID(),
      lift: data.lift,
      client: data.client || '',
      car: data.car || '',
      plate: data.plate || '',
      phone: data.phone || '',
      mileage: data.mileage || '',
      parts: data.parts || [],
      workItems: data.workItems || [],
      partsDraft: data.partsDraft || [],
      dateFrom: data.dateFrom,
      dateTo: data.dateTo,
      start: data.start,
      end: data.end,
      desc: data.desc || '',
      notes: data.notes || '',
      status: data.status || 'planned',
      statusNote: data.statusNote || '',
      paid: PAID_VALUES.includes(data.paid) ? data.paid : 'no',
      paymentMethod: PAYMENT_METHOD_VALUES.includes(data.paymentMethod) ? data.paymentMethod : '',
      archived: false,
      // Ar rodyti Darbų valdymo skirtuke. Numatytoji reikšmė — true (rodoma),
      // nebent klientas eksplicitiškai atsiuntė showInJobs: false (žr.
      // pickFields — laukas patenka į `data` tik jei klientas jį atsiuntė).
      showInJobs: data.showInJobs !== undefined ? !!data.showInJobs : true,
      createdBy: user.username,
      updatedAt: new Date().toISOString(),
    };
    await withDb(db => {
      db.events.push(ev);
      upsertVehicleForPlate(db, ev, user.username);
    });
    return sendJson(res, 201, ev);
  }

  const eventIdMatch = pathname.match(/^\/api\/events\/([^/]+)$/);
  if (eventIdMatch && method === 'PUT') {
    const id = decodeURIComponent(eventIdMatch[1]);
    const body = await readJsonBody(req);
    const patch = pickFields(body);

    // Darbuotojo (role: "employee") paskyra negali redaguoti jokių kitų
    // darbo laukų — leidžiama tik keisti būseną (status), o kartu su ja
    // (jei reikia užfiksuoti realų pabaigos laiką sustabdant ilgėjimą) —
    // ir "end" lauką. Bet koks kitas laukas patch'e — atmetama.
    if (isReadOnly(user)) {
      const EMP_ALLOWED_PATCH_FIELDS = ['status', 'end', 'statusNote'];
      const patchKeys = Object.keys(patch);
      const isStatusOnlyChange = patchKeys.length > 0 &&
        patchKeys.every(k => EMP_ALLOWED_PATCH_FIELDS.includes(k)) &&
        patchKeys.includes('status');
      if (!isStatusOnlyChange) {
        return sendJson(res, 403, { error: 'Jūsų paskyra gali keisti tik darbo būseną.' });
      }
    }
    let result = null, errStatus = null, errMsg = null;

    await withDb(db => {
      const idx = db.events.findIndex(e => e.id === id);
      if (idx === -1) { errStatus = 404; errMsg = 'Įrašas nerastas.'; return; }
      if (!canAccessLift(user, db.events[idx].lift)) { errStatus = 404; errMsg = 'Įrašas nerastas.'; return; }
      const merged = { ...db.events[idx], ...patch };
      if (!merged.dateTo) merged.dateTo = merged.dateFrom;
      const errors = validateEvent(merged);
      if (errors.length) { errStatus = 400; errMsg = errors.join(' '); return; }
      if (!canAccessLift(user, merged.lift)) { errStatus = 403; errMsg = 'Neturite teisės perkelti darbo į šį keltuvą.'; return; }
      merged.updatedAt = new Date().toISOString();
      merged.updatedBy = user.username;
      db.events[idx] = merged;
      upsertVehicleForPlate(db, merged, user.username);
      result = merged;
    });

    if (errStatus) return sendJson(res, errStatus, { error: errMsg });
    return sendJson(res, 200, result);
  }

  if (eventIdMatch && method === 'DELETE') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite trinti darbų.' });
    }
    const id = decodeURIComponent(eventIdMatch[1]);
    let found = false;
    await withDb(db => {
      const idx = db.events.findIndex(e => e.id === id);
      if (idx === -1) return;
      if (!canAccessLift(user, db.events[idx].lift)) return;
      db.events.splice(idx, 1);
      found = true;
    });
    if (!found) return sendJson(res, 404, { error: 'Įrašas nerastas.' });
    res.writeHead(204);
    return res.end();
  }

  /* ── AUTOMOBILIAI ── */
  if (pathname === '/api/vehicles' && method === 'GET') {
    const db = readDb();
    return sendJson(res, 200, db.vehicles || []);
  }

  if (pathname === '/api/vehicles' && method === 'POST') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite kurti automobilių.' });
    }
    const body = await readJsonBody(req, 6e6);
    const plate = normalizePlate(body.plate);
    if (!plate) return sendJson(res, 400, { error: 'Įveskite valstybinį numerį.' });
    const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 200) : '');

    let result = null, errStatus = null, errMsg = null;
    await withDb(db => {
      if (!Array.isArray(db.vehicles)) db.vehicles = [];
      if (db.vehicles.some(v => normalizePlate(v.plate) === plate)) {
        errStatus = 400; errMsg = 'Automobilis su tokiu valstybiniu numeriu jau yra duomenų bazėje.'; return;
      }
      const veh = {
        id: crypto.randomUUID(),
        plate,
        car: s(body.car),
        client: s(body.client),
        phone: s(body.phone, 40),
        photoUrl: '',
        createdBy: user.username,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (typeof body.photo === 'string' && body.photo) {
        try {
          veh.photoUrl = saveVehiclePhoto(veh.id, body.photo);
        } catch (e) {
          errStatus = 400; errMsg = e.message; return;
        }
      }
      db.vehicles.push(veh);
      result = veh;
    });
    if (errStatus) return sendJson(res, errStatus, { error: errMsg });
    return sendJson(res, 201, result);
  }

  const vehicleIdMatch = pathname.match(/^\/api\/vehicles\/([^/]+)$/);
  if (vehicleIdMatch && method === 'PUT') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite redaguoti automobilių.' });
    }
    const id = decodeURIComponent(vehicleIdMatch[1]);
    const body = await readJsonBody(req, 6e6);
    const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 200) : '');

    let result = null, errStatus = null, errMsg = null;
    await withDb(db => {
      const idx = (db.vehicles || []).findIndex(v => v.id === id);
      if (idx === -1) { errStatus = 404; errMsg = 'Automobilis nerastas.'; return; }
      const veh = db.vehicles[idx];
      if (body.plate !== undefined) {
        const plate = normalizePlate(body.plate);
        if (!plate) { errStatus = 400; errMsg = 'Įveskite valstybinį numerį.'; return; }
        if (db.vehicles.some(v => v.id !== id && normalizePlate(v.plate) === plate)) {
          errStatus = 400; errMsg = 'Automobilis su tokiu valstybiniu numeriu jau yra duomenų bazėje.'; return;
        }
        veh.plate = plate;
      }
      if (body.car !== undefined) veh.car = s(body.car);
      if (body.client !== undefined) veh.client = s(body.client);
      if (body.phone !== undefined) veh.phone = s(body.phone, 40);
      if (body.removePhoto) {
        deleteVehiclePhotoFiles(veh.id);
        veh.photoUrl = '';
      } else if (typeof body.photo === 'string' && body.photo) {
        try {
          veh.photoUrl = saveVehiclePhoto(veh.id, body.photo);
        } catch (e) {
          errStatus = 400; errMsg = e.message; return;
        }
      }
      veh.updatedAt = new Date().toISOString();
      veh.updatedBy = user.username;
      result = veh;
    });
    if (errStatus) return sendJson(res, errStatus, { error: errMsg });
    return sendJson(res, 200, result);
  }

  if (vehicleIdMatch && method === 'DELETE') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite trinti automobilių.' });
    }
    const id = decodeURIComponent(vehicleIdMatch[1]);
    let found = false;
    await withDb(db => {
      const idx = (db.vehicles || []).findIndex(v => v.id === id);
      if (idx === -1) return;
      deleteVehiclePhotoFiles(id);
      db.vehicles.splice(idx, 1);
      found = true;
    });
    if (!found) return sendJson(res, 404, { error: 'Automobilis nerastas.' });
    res.writeHead(204);
    return res.end();
  }

  /* ── DARBŲ ŠABLONAI ── (pvz. "Audi A6 grandinės keitimas", "DSG DQ250
     alyvos keitimas") — iš anksto paruoštas dalių ir/ar darbų sąrašas,
     kurį galima vienu paspaudimu pritaikyti bet kuriam darbui (žr.
     buildPartsSection/buildWorkSection index.html), kad nereikėtų kaskart
     iš naujo ranka suvedinėti tų pačių dalių. Peržiūrai (GET) prieinama
     visiems prisijungusiems, bet tvarkyti (POST/PUT/DELETE) gali tik
     owner/reception paskyros — darbuotojų (role: "employee") paskyros šio
     puslapio net nemato kliento pusėje, bet serveris vis tiek tikrina. */
  if (pathname === '/api/templates' && method === 'GET') {
    const db = readDb();
    return sendJson(res, 200, db.templates || []);
  }

  if (pathname === '/api/templates' && method === 'POST') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite kurti šablonų.' });
    }
    const body = await readJsonBody(req, 6e6);
    const name = (typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '');
    if (!name) return sendJson(res, 400, { error: 'Įveskite šablono pavadinimą.' });
    const tpl = {
      id: crypto.randomUUID(),
      name,
      parts: sanitizeParts(body.parts),
      workItems: sanitizeWorkItems(body.workItems),
      createdBy: user.username,
      updatedAt: new Date().toISOString(),
    };
    await withDb(db => {
      if (!Array.isArray(db.templates)) db.templates = [];
      db.templates.push(tpl);
    });
    return sendJson(res, 201, tpl);
  }

  const templateIdMatch = pathname.match(/^\/api\/templates\/([^/]+)$/);
  if (templateIdMatch && method === 'PUT') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite redaguoti šablonų.' });
    }
    const id = decodeURIComponent(templateIdMatch[1]);
    const body = await readJsonBody(req, 6e6);
    let result = null, errStatus = null, errMsg = null;
    await withDb(db => {
      const idx = (db.templates || []).findIndex(t => t.id === id);
      if (idx === -1) { errStatus = 404; errMsg = 'Šablonas nerastas.'; return; }
      const tpl = db.templates[idx];
      if (body.name !== undefined) {
        const name = (typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '');
        if (!name) { errStatus = 400; errMsg = 'Įveskite šablono pavadinimą.'; return; }
        tpl.name = name;
      }
      if (body.parts !== undefined) tpl.parts = sanitizeParts(body.parts);
      if (body.workItems !== undefined) tpl.workItems = sanitizeWorkItems(body.workItems);
      tpl.updatedAt = new Date().toISOString();
      tpl.updatedBy = user.username;
      result = tpl;
    });
    if (errStatus) return sendJson(res, errStatus, { error: errMsg });
    return sendJson(res, 200, result);
  }

  if (templateIdMatch && method === 'DELETE') {
    if (isReadOnly(user)) {
      return sendJson(res, 403, { error: 'Jūsų paskyra turi tik peržiūros teises — negalite trinti šablonų.' });
    }
    const id = decodeURIComponent(templateIdMatch[1]);
    let found = false;
    await withDb(db => {
      const idx = (db.templates || []).findIndex(t => t.id === id);
      if (idx === -1) return;
      db.templates.splice(idx, 1);
      found = true;
    });
    if (!found) return sendJson(res, 404, { error: 'Šablonas nerastas.' });
    res.writeHead(204);
    return res.end();
  }

  return sendJson(res, 404, { error: 'Nerasta.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, method);
      return;
    }

    // Automobilių nuotraukos saugomos DATA_DIR (nuolatiniame diske), o ne
    // public/ (kuris perrašomas kaskart išdiegus iš git) — patiekiama
    // atskirai, reikalaujant prisijungimo, kaip ir kiti duomenys.
    if (pathname.startsWith('/vehicle-photos/') && (method === 'GET' || method === 'HEAD')) {
      const user = getAuthUser(req);
      if (!user) { res.writeHead(401); return res.end(); }
      if (serveStatic(res, VEHICLE_PHOTO_DIR, pathname.replace('/vehicle-photos', ''))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nerasta.');
    }

    if (method === 'GET' || method === 'HEAD') {
      const staticPath = pathname === '/' ? '/index.html' : pathname;
      if (serveStatic(res, PUBLIC_DIR, staticPath)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nerasta.');
    }

    sendJson(res, 405, { error: 'Metodas neleidžiamas.' });
  } catch (err) {
    console.error('[SERVER ERROR]', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Serverio klaida.' });
    else res.end();
  }
});

const PORT = process.env.PORT || 3000;
migrateEvents()
  .catch(err => console.error('[MIGRACIJA] Nepavyko pritaikyti keltuvų migracijos:', err))
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`AutoServisas Kalendorius serveris veikia: http://localhost:${PORT}`);
    });
  });
