// lib/rooms.js — in-memory room store + multiplayer game-flow for Sweat Room.
// This is what makes a shared link actually work: a room holds real server-side state
// (whose hands are dealt, who's arranged what, how much of each board is known) so that
// several browsers — on different devices — can each see only what they're supposed to:
// your own 7 cards stay secret to you until every seat is filled and ready, at which point
// hands are "tabled" (shown to everyone, like a real sweat) and the board reveal that
// follows is driven by the host and mirrored to everyone else. Node-only (uses crypto for
// ids), not meant to run in the browser, so it's required directly rather than UMD-wrapped.
'use strict';
const crypto = require('crypto');
const G = require('./game.js');
const E = require('./equity.js');

const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // purge rooms idle for 3+ hours
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read aloud
const STAGE_ORDER = ['flops', 'turnA', 'turnB', 'riverA', 'riverB', 'done'];
const CONNECTED_WINDOW_MS = 20000; // no heartbeat/poll in this long -> shown as disconnected

// The reveal paces itself — nobody has to click through flop/turn/river. Every stage sits
// revealed for AUTO_HOLD_MS before the next one starts, except a river that turns out to be
// a swing spot, which instead waits (indefinitely) for the host to physically complete the
// squeeze (see advanceRoom below). Tests set SWEAT_ROOM_FAST_TIMERS=1 to shrink these to a
// few milliseconds so a full hand doesn't take 10+ seconds of real wall-clock time to verify.
const FAST = !!process.env.SWEAT_ROOM_FAST_TIMERS;
const AUTO_INITIAL_MS = FAST ? 15 : 1000;
const AUTO_HOLD_MS = FAST ? 15 : 2500;

const rooms = new Map(); // code -> room

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function randomCode(len = 5) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function randomId() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanName(name, fallback) {
  const trimmed = String(name || '').trim().slice(0, 24);
  return trimmed || fallback;
}

function makeSeat(id, name, seatIndex) {
  return {
    id,
    name: cleanName(name, `Player ${seatIndex + 1}`),
    seatIndex,
    lastSeenAt: Date.now(),
    ready: false,
    assignment: null
  };
}

function touch(room) { room.lastActivityAt = Date.now(); }

function clearAutoTimer(room) {
  if (room.autoTimer) { clearTimeout(room.autoTimer); room.autoTimer = null; }
}

// Schedules fn to run after delayMs, replacing any previously scheduled auto-advance for
// this room. Every entry point is guarded against the room having moved on (reset, new
// hand, deleted) in the meantime, so a stale timer firing late is always a safe no-op.
function scheduleAuto(room, delayMs, fn) {
  clearAutoTimer(room);
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (rooms.get(room.code) !== room || room.phase !== 'sweat') return;
    Promise.resolve(fn()).catch(() => { /* a timer tick failing silently is better than crashing the server */ });
  }, delayMs);
}

function resetHandState(room) {
  clearAutoTimer(room);
  room.dealt = null;
  room.boards = null;
  room.revealedA = 0;
  room.revealedB = 0;
  room.stageIndex = 0;
  room.pendingSwing = null;
}

function createRoom({ hostName, capacity, homerunMode }) {
  capacity = Number(capacity);
  if (![2, 3, 4].includes(capacity)) throw httpError(400, 'Players must be 2, 3, or 4.');

  let code;
  do { code = randomCode(); } while (rooms.has(code));
  const hostId = randomId();

  const room = {
    code,
    capacity,
    homerunMode: !!homerunMode,
    hostId,
    phase: 'lobby', // lobby -> arranging -> sweat
    players: [makeSeat(hostId, hostName, 0)],
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  };
  resetHandState(room);
  rooms.set(code, room);
  return { room, playerId: hostId };
}

function getRoom(code) {
  const room = rooms.get(String(code || '').trim().toUpperCase());
  if (!room) throw httpError(404, 'Room not found. Double-check the code or ask for a fresh link.');
  return room;
}

function getPlayer(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw httpError(403, 'You are not seated in this room.');
  return player;
}

function requireHost(room, playerId) {
  if (playerId !== room.hostId) throw httpError(403, 'Only the host can do that.');
}

function joinRoom(code, { name }) {
  const room = getRoom(code);
  if (room.phase !== 'lobby') throw httpError(409, 'This room has already started its hand — ask the host for a new one.');
  if (room.players.length >= room.capacity) throw httpError(409, 'This room is already full.');
  const id = randomId();
  room.players.push(makeSeat(id, name, room.players.length));
  touch(room);
  return { room, playerId: id };
}

function dealRoom(code, playerId) {
  const room = getRoom(code);
  getPlayer(room, playerId);
  requireHost(room, playerId);
  if (room.phase !== 'lobby') throw httpError(409, 'This hand has already been dealt.');
  if (room.players.length !== room.capacity) {
    throw httpError(409, `Waiting for all ${room.capacity} players to join (${room.players.length}/${room.capacity} so far).`);
  }
  resetHandState(room); // also cancels any leftover auto-timer from a previous hand
  const ids = room.players.map((p) => p.id);
  const { hands, boards } = G.dealHand(ids, 7);
  room.dealt = hands;
  room.boards = boards;
  room.players.forEach((p) => { p.ready = false; p.assignment = null; });
  room.phase = 'arranging';
  touch(room);
  return room;
}

function submitAssignment(code, playerId, assignment) {
  const room = getRoom(code);
  const player = getPlayer(room, playerId);
  if (room.phase !== 'arranging') throw httpError(409, 'Not currently arranging hands.');
  const dealtCards = room.dealt[playerId];
  const err = G.validateAssignment(dealtCards, assignment);
  if (err) throw httpError(400, err);
  player.assignment = assignment;
  player.ready = true;
  touch(room);
  if (room.players.every((p) => p.ready)) {
    // Hands are tabled — everyone can now see everyone's split, and the board sweat begins
    // entirely on its own: nobody needs to click anything for flop/turn/river to happen,
    // except physically completing the squeeze on a river that turns out to be a swing spot.
    room.phase = 'sweat';
    scheduleAuto(room, AUTO_INITIAL_MS, () => autoTick(room));
  }
  return room;
}

function currentStageId(room) { return STAGE_ORDER[room.stageIndex]; }

// The automatic flop/turn/river driver. Each tick reveals the next stage's cards and, for
// flop/turnA/turnB, just schedules the next tick after AUTO_HOLD_MS. A river is different:
// it first needs the outs/swing check (async, so it gets its own function) before deciding
// whether to auto-complete itself (no swing) or stop and wait for the host's squeeze.
async function autoTick(room) {
  const stage = currentStageId(room);
  if (stage === 'flops') {
    room.revealedA = 3;
    room.revealedB = 3;
    room.stageIndex += 1;
    touch(room);
    scheduleAuto(room, AUTO_HOLD_MS, () => autoTick(room));
  } else if (stage === 'turnA') {
    room.revealedA = 4;
    room.stageIndex += 1;
    touch(room);
    scheduleAuto(room, AUTO_HOLD_MS, () => autoTick(room));
  } else if (stage === 'turnB') {
    room.revealedB = 4;
    room.stageIndex += 1;
    touch(room);
    scheduleAuto(room, AUTO_HOLD_MS, () => autoTick(room));
  } else if (stage === 'riverA' || stage === 'riverB') {
    await autoRiverCheck(room, stage === 'riverA' ? 0 : 1);
  }
  // 'done' — nothing left to tick.
}

// Runs the outs/swing check for the pending river and stores it where every viewer's poll
// picks it up identically. If it's NOT a swing spot, the river just completes itself after
// another hold, same as any other stage. If it IS a swing spot, the hand stops advancing on
// its own here — advanceRoom (below) is the only way past it, and only the host can call it,
// modeling "the host physically does the squeeze while everyone else watches."
async function autoRiverCheck(room, boardIndex) {
  const players = room.players.map((p) => ({ id: p.id, name: p.name, assignment: p.assignment }));
  const boards = [
    room.boards[0].slice(0, room.revealedA),
    room.boards[1].slice(0, room.revealedB)
  ];
  const swing = await E.computeRiverSwing({ players, boards, pendingBoardIndex: boardIndex, homerunMode: room.homerunMode });
  if (rooms.get(room.code) !== room || room.phase !== 'sweat') return; // room moved on while we awaited
  room.pendingSwing = {
    boardIndex,
    hasSwing: swing.hasSwing,
    swingThreshold: swing.swingThreshold,
    outs: swing.outs.map((o) => ({ card: o.card, beneficiary: o.beneficiary, maxAbsDelta: o.maxAbsDelta }))
  };
  touch(room);
  if (!swing.hasSwing) {
    scheduleAuto(room, AUTO_HOLD_MS, () => completeRiver(room, boardIndex));
  }
  // if it IS a swing: stop here and wait for advanceRoom to be called for this board.
}

function completeRiver(room, boardIndex) {
  if (boardIndex === 0) room.revealedA = 5; else room.revealedB = 5;
  room.pendingSwing = null;
  room.stageIndex += 1;
  touch(room);
  if (currentStageId(room) !== 'done') scheduleAuto(room, AUTO_HOLD_MS, () => autoTick(room));
}

// The only reveal action a client still ever calls directly: completing the squeeze on a
// river that the automatic outs check flagged as a swing spot. Everything else (flop, both
// turns, and any non-swing river) advances entirely on the server's own clock.
function advanceRoom(code, playerId, action) {
  const room = getRoom(code);
  getPlayer(room, playerId);
  requireHost(room, playerId);
  if (room.phase !== 'sweat') throw httpError(409, 'Not currently sweating a hand.');
  const stage = currentStageId(room);
  if (action !== stage) throw httpError(409, `Expected to reveal "${stage}" next, got "${action}".`);
  if (stage !== 'riverA' && stage !== 'riverB') {
    throw httpError(409, 'This stage reveals itself automatically — there is nothing to complete.');
  }
  const boardIndex = stage === 'riverA' ? 0 : 1;
  if (!room.pendingSwing || room.pendingSwing.boardIndex !== boardIndex || !room.pendingSwing.hasSwing) {
    throw httpError(409, 'This river is not currently waiting on a squeeze.');
  }
  completeRiver(room, boardIndex);
  return room;
}

function newHandRoom(code, playerId) {
  const room = getRoom(code);
  getPlayer(room, playerId);
  requireHost(room, playerId);
  room.phase = 'lobby';
  resetHandState(room);
  room.players.forEach((p) => { p.ready = false; p.assignment = null; });
  touch(room);
  return room;
}

function heartbeat(code, playerId) {
  const room = getRoom(code);
  const player = getPlayer(room, playerId);
  player.lastSeenAt = Date.now();
  touch(room);
  return room;
}

// What a given viewer is allowed to see of the room — hides every OTHER player's dealt
// hand until all seats are ready (hands tabled), and never exposes a board card beyond
// how far the host has actually revealed it.
function viewFor(room, playerId) {
  const me = room.players.find((p) => p.id === playerId) || null;
  const now = Date.now();
  const handsVisible = room.phase === 'sweat';

  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    seatIndex: p.seatIndex,
    connected: now - p.lastSeenAt < CONNECTED_WINDOW_MS,
    ready: p.ready,
    isHost: p.id === room.hostId,
    assignment: handsVisible ? p.assignment : null
  }));

  const out = {
    code: room.code,
    capacity: room.capacity,
    homerunMode: room.homerunMode,
    phase: room.phase,
    hostId: room.hostId,
    isHost: !!me && me.id === room.hostId,
    you: me ? { id: me.id, name: me.name, seatIndex: me.seatIndex } : null,
    players,
    stageIndex: room.stageIndex,
    stage: STAGE_ORDER[room.stageIndex] || null,
    pendingSwing: room.pendingSwing
  };

  if (room.phase === 'arranging' && me) {
    out.yourHand = room.dealt[me.id];
  }
  if (room.phase === 'sweat') {
    out.boardA = room.boards[0].slice(0, room.revealedA);
    out.boardB = room.boards[1].slice(0, room.revealedB);
    out.revealedA = room.revealedA;
    out.revealedB = room.revealedB;
  }
  return out;
}

function sweepStaleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivityAt > ROOM_TTL_MS) {
      clearAutoTimer(room);
      rooms.delete(code);
    }
  }
}

function _reset() { // test-only helper
  for (const room of rooms.values()) clearAutoTimer(room);
  rooms.clear();
}

module.exports = {
  createRoom,
  joinRoom,
  dealRoom,
  submitAssignment,
  advanceRoom,
  newHandRoom,
  heartbeat,
  viewFor,
  getRoom,
  getPlayer,
  sweepStaleRooms,
  STAGE_ORDER,
  AUTO_INITIAL_MS,
  AUTO_HOLD_MS,
  _reset
};
