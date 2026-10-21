// server.js — zero-dependency static file server for Sweat Room.
// Same pattern as the sibling taiwanese-poker / ultimate-texas-holdem projects.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3400;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function send(res, status, body, contentType) {
  res.writeHead(status, { 'Content-Type': contentType || 'text/plain; charset=utf-8' });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath);
    send(res, 200, data, MIME[ext] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath === '/' || urlPath === '/index.html') {
    serveFile(res, path.join(ROOT, 'public', 'index.html'));
    return;
  }
  if (urlPath.startsWith('/lib/')) {
    const rel = urlPath.slice('/lib/'.length);
    if (rel.includes('..')) { send(res, 400, 'Bad path'); return; }
    serveFile(res, path.join(ROOT, 'lib', rel));
    return;
  }
  if (urlPath.startsWith('/public/')) {
    const rel = urlPath.slice('/public/'.length);
    if (rel.includes('..')) { send(res, 400, 'Bad path'); return; }
    serveFile(res, path.join(ROOT, 'public', rel));
    return;
  }
  // allow bare references like /client.js, /style.css from inside public/index.html
  const bareCandidate = path.join(ROOT, 'public', urlPath);
  if (fs.existsSync(bareCandidate) && fs.statSync(bareCandidate).isFile()) {
    serveFile(res, bareCandidate);
    return;
  }

  send(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`Sweat Room listening on http://localhost:${PORT}`);
});
