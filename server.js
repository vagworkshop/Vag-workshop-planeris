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
const { validateEvent } = require('./lib/validate');
const { parseCookies, serializeCookie, readJsonBody, sendJson } = require('./lib/http-utils');
const { serveStatic } = require('./lib/static');

const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

seedUsers();

const ALLOWED_FIELDS = ['emp', 'client', 'car', 'dateFrom', 'dateTo', 'start', 'end', 'desc'];
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
    return sendJson(res, 200, { user: { username: user.username, displayName: user.displayName, empId: user.empId } });
  }

  if (pathname === '/api/events' && method === 'GET') {
    const db = readDb();
    return sendJson(res, 200, db.events);
  }

  if (pathname === '/api/events' && method === 'POST') {
    const body = await readJsonBody(req);
    const data = pickFields(body);
    if (!data.dateTo) data.dateTo = data.dateFrom;
    const errors = validateEvent(data);
    if (errors.length) return sendJson(res, 400, { error: errors.join(' ') });

    const ev = {
      id: crypto.randomUUID(),
      emp: data.emp,
      client: data.client || '',
      car: data.car || '',
      dateFrom: data.dateFrom,
      dateTo: data.dateTo,
      start: data.start,
      end: data.end,
      desc: data.desc || '',
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
    let result = null, errStatus = null, errMsg = null;

    await withDb(db => {
      const idx = db.events.findIndex(e => e.id === id);
      if (idx === -1) { errStatus = 404; errMsg = 'Įrašas nerastas.'; return; }
      const merged = { ...db.events[idx], ...patch };
      if (!merged.dateTo) merged.dateTo = merged.dateFrom;
      const errors = validateEvent(merged);
      if (errors.length) { errStatus = 400; errMsg = errors.join(' '); return; }
      merged.updatedAt = new Date().toISOString();
      merged.updatedBy = user.username;
      db.events[idx] = merged;
      result = merged;
    });

    if (errStatus) return sendJson(res, errStatus, { error: errMsg });
    return sendJson(res, 200, result);
  }

  if (eventIdMatch && method === 'DELETE') {
    const id = decodeURIComponent(eventIdMatch[1]);
    let found = false;
    await withDb(db => {
      const before = db.events.length;
      db.events = db.events.filter(e => e.id !== id);
      found = db.events.length < before;
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
server.listen(PORT, () => {
  console.log(`AutoServisas Kalendorius serveris veikia: http://localhost:${PORT}`);
});
