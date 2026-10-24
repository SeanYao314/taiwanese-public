// server.js — zero-dependency static file server AND the multiplayer room API for Sweat
// Room. The static-file half is unchanged from before; the JSON API under /api/rooms/* is
// what makes "send someone the link" actually work — it's a small in-memory room store
// (lib/rooms.js) that keeps each player's dealt hand secret from the others until the whole
// table is ready, then paces the board reveal itself on its own clock (flop/turn/river, no
// clicking) that every connected browser polls and mirrors. The one thing that still needs
// a human is physically completing the squeeze on a river that turns out to be a swing spot
// — the host does that, via POST .../advance.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const Rooms = require('./lib/rooms.js');

const PORT = process.env.PORT || 3400;
const ROOT = __dirname;
const MAX_BODY_BYTES = 64 * 1024;

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

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
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

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Malformed JSON body.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Every /api/rooms/* handler ends up returning { room: <viewFor(...)> } on success, scoped
// to whichever playerId made the request — this one helper keeps that consistent and turns
// any httpError thrown by lib/rooms.js into the right status code + { error } body.
async function handleRoomAction(res, playerIdForView, codeForView, fn) {
  try {
    await fn();
    const room = Rooms.getRoom(codeForView);
    sendJSON(res, 200, { room: Rooms.viewFor(room, playerIdForView) });
  } catch (err) {
    sendJSON(res, err.status || 500, { error: err.message || 'Something went wrong.' });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://internal');
  const urlPath = decodeURIComponent(urlObj.pathname);
  const method = req.method;

  // ---------------- Multiplayer room API ----------------
  if (urlPath === '/api/rooms' && method === 'POST') {
    try {
      const body = await readJSONBody(req);
      const { room, playerId } = Rooms.createRoom(body);
      sendJSON(res, 201, { room: Rooms.viewFor(room, playerId), playerId });
    } catch (err) {
      sendJSON(res, err.status || 500, { error: err.message || 'Something went wrong.' });
    }
    return;
  }

  const roomMatch = urlPath.match(/^\/api\/rooms\/([A-Za-z0-9]+)(?:\/([a-z-]+))?$/);
  if (roomMatch) {
    const code = roomMatch[1];
    const action = roomMatch[2] || null;

    if (!action && method === 'GET') {
      const playerId = urlObj.searchParams.get('playerId') || '';
      await handleRoomAction(res, playerId, code, () => {
        Rooms.heartbeat(code, playerId); // also serves as a liveness ping
      });
      return;
    }

    if (action === 'join' && method === 'POST') {
      try {
        const body = await readJSONBody(req);
        const { room, playerId } = Rooms.joinRoom(code, body);
        sendJSON(res, 200, { room: Rooms.viewFor(room, playerId), playerId });
      } catch (err) {
        sendJSON(res, err.status || 500, { error: err.message || 'Something went wrong.' });
      }
      return;
    }

    if (action === 'deal' && method === 'POST') {
      const body = await readJSONBody(req).catch(() => ({}));
      await handleRoomAction(res, body.playerId, code, () => Rooms.dealRoom(code, body.playerId));
      return;
    }

    if (action === 'submit' && method === 'POST') {
      const body = await readJSONBody(req).catch(() => ({}));
      await handleRoomAction(res, body.playerId, code, () => Rooms.submitAssignment(code, body.playerId, body.assignment));
      return;
    }

    if (action === 'advance' && method === 'POST') {
      const body = await readJSONBody(req).catch(() => ({}));
      await handleRoomAction(res, body.playerId, code, () => Rooms.advanceRoom(code, body.playerId, body.action));
      return;
    }

    if (action === 'new-hand' && method === 'POST') {
      const body = await readJSONBody(req).catch(() => ({}));
      await handleRoomAction(res, body.playerId, code, () => Rooms.newHandRoom(code, body.playerId));
      return;
    }

    send(res, 404, 'Not found');
    return;
  }

  // ---------------- Static files ----------------
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
  if (!urlPath.includes('..') && fs.existsSync(bareCandidate) && fs.statSync(bareCandidate).isFile()) {
    serveFile(res, bareCandidate);
    return;
  }

  send(res, 404, 'Not found');
});

// Idle rooms (no activity for 3+ hours) are swept out of memory periodically so a
// long-running server doesn't accumulate abandoned rooms forever.
const sweepInterval = setInterval(() => Rooms.sweepStaleRooms(), 10 * 60 * 1000);
if (sweepInterval.unref) sweepInterval.unref();

server.listen(PORT, () => {
  console.log(`Sweat Room listening on http://localhost:${PORT}`);
});

module.exports = server;
