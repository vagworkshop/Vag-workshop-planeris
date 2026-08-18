'use strict';
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// Saugiai patiekia failą iš `rootDir`, pagal `reqPath` (pvz. "/index.html").
// Apsaugo nuo "../" kelio pabėgimo. Grąžina true jei failas rastas ir
// pateiktas, false jei ne (kad kviečiantis kodas galėtų nuspręsti, ką
// daryti toliau, pvz. grąžinti 404).
function serveStatic(res, rootDir, reqPath) {
  const safeSuffix = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(rootDir, safeSuffix);
  if (!filePath.startsWith(path.resolve(rootDir))) return false;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return false;
  }
  if (stat.isDirectory()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

module.exports = { serveStatic };
