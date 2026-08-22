'use strict';
// AutoServisas Kalendorius — serveris.
// Sąmoningai parašytas naudojant TIK Node.js integruotus modulius (http, fs,
// path, crypto) — jokių "npm install" priklausomybių, todėl diegimas
// niekada nesugrius dėl paketų problemos ir veikia identiškai bet kurioje
// aplinkoje, kurioje yra Node.js.

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');

const { withDb, readDb } = require('./lib/db');
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

const ALLOWED_FIELDS = ['lift', 'client', 'car', 'dateFrom', 'dateTo', 'start', 'end', 'desc', 'status'];
function pickFields(body) {
  const out = {};
  ALLOWED_FIELDS.forEach(k => {
    if (body[k] !== undefined && body[k] !== null) {
      out[k] = typeof body[k] === 'string' ? body[k] : String(body[k]);
    }
  });
  ['client', 'car', 'desc'].forEach(k => { if (typeof out[k] === 'string') out[k] = out[k].trim(); });
  return out;
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
      dateFrom: data.dateFrom,
      dateTo: data.dateTo,
      start: data.start,
      end: data.end,
      desc: data.desc || '',
      status: data.status || 'planned',
      createdBy: user.username,
      updatedAt: new Date().toISOString(),
    };
    await withDb(db => { db.events.push(ev); });
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
      const EMP_ALLOWED_PATCH_FIELDS = ['status', 'end'];
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
