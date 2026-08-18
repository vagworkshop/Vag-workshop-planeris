'use strict';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
    }
  });
  return out;
}

function serializeCookie(name, value, opts) {
  opts = opts || {};
  let str = name + '=' + encodeURIComponent(value);
  str += '; Path=' + (opts.path || '/');
  if (opts.maxAge != null) str += '; Max-Age=' + Math.floor(opts.maxAge / 1000);
  if (opts.expires) str += '; Expires=' + opts.expires.toUTCString();
  if (opts.httpOnly) str += '; HttpOnly';
  if (opts.sameSite) str += '; SameSite=' + opts.sameSite;
  if (opts.secure) str += '; Secure';
  return str;
}

function readJsonBody(req, maxBytes) {
  maxBytes = maxBytes || 1e6; // 1MB
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        reject(new Error('Užklausos turinys per didelis.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Neteisingas JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

module.exports = { parseCookies, serializeCookie, readJsonBody, sendJson };
