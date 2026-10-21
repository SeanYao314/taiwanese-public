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

function resetHandState(room) {
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
  const ids = room.players.map((p) => p.id);
  const { hands, boards } = G.dealHand(ids, 7);
  room.dealt = hands;
  room.boards = boards;
  room.players.forEach((p) => { p.ready = false; p.assignment = null; });
  room.revealedA = 0;
  room.revealedB = 0;
  room.stageIndex = 0;
  room.pendingSwing = null;
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
    // Hands are tabled — everyone can now see everyone's split, and the board sweat begins.
    room.phase = 'sweat';
  }
  return room;
}

function currentStageId(room) { return STAGE_ORDER[room.stageIndex]; }

function advanceRoom(code, playerId, action) {
  const room = getRoom(code);
  getPlayer(room, playerId);
  requireHost(room, playerId);
  if (room.phase !== 'sweat') throw httpError(409, 'Not currently sweating a hand.');
  const stage = currentStageId(room);
  if (action !== stage) throw httpError(409, `Expected to reveal "${stage}" next, got "${action}".`);

  if (stage === 'flops') { room.revealedA = 3; room.revealedB = 3; }
  else if (stage === 'turnA') { room.revealedA = 4; }
  else if (stage === 'turnB') { room.revealedB = 4; }
  else if (stage === 'riverA') { room.revealedA = 5; room.pendingSwing = null; }
  else if (stage === 'riverB') { room.revealedB = 5; room.pendingSwing = null; }
  else throw httpError(409, 'Nothing left to reveal — the hand is already fully shown.');

  room.stageIndex += 1;
  touch(room);
  return room;
}

async function checkRiverSwing(code, playerId, boardIndex) {
  const room = getRoom(code);
  getPlayer(room, playerId);
  requireHost(room, playerId);
  if (room.phase !== 'sweat') throw httpError(409, 'Not currently sweating a hand.');
  const stage = currentStageId(room);
  const expected = boardIndex === 0 ? 'riverA' : 'riverB';
  if (stage !== expected) throw httpError(409, `Not at the ${expected === 'riverA' ? 'board A' : 'board B'} river yet.`);

  const players = room.players.map((p) => ({ id: p.id, name: p.name, assignment: p.assignment }));
  const boards = [
    room.boards[0].slice(0, room.revealedA),
    room.boards[1].slice(0, room.revealedB)
  ];
  const swing = await E.computeRiverSwing({ players, boards, pendingBoardIndex: boardIndex, homerunMode: room.homerunMode });
  room.pendingSwing = {
    boardIndex,
    hasSwing: swing.hasSwing,
    swingThreshold: swing.swingThreshold,
    outs: swing.outs.map((o) => ({ card: o.card, beneficiary: o.beneficiary, maxAbsDelta: o.maxAbsDelta }))
  };
  touch(room);
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
    if (now - room.lastActivityAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

function _reset() { rooms.clear(); } // test-only helper

module.exports = {
  createRoom,
  joinRoom,
  dealRoom,
  submitAssignment,
  advanceRoom,
  checkRiverSwing,
  newHandRoom,
  heartbeat,
  viewFor,
  getRoom,
  getPlayer,
  sweepStaleRooms,
  STAGE_ORDER,
  _reset
};
