// tests/rooms_api.test.js — exercises the real multiplayer server (server.js + lib/rooms.js)
// over actual HTTP, simulating two separate browsers (two players) hitting the JSON API.
// This is the piece that makes "send someone the link" work, so it gets tested as the real
// request/response cycle a browser would drive, not just by calling lib/rooms.js functions
// directly — in particular, it proves hidden information actually stays hidden across the
// wire (one player's view of room state never contains another player's cards until hands
// are tabled), and that host-only actions are rejected for non-host players.
// Run with: node tests/rooms_api.test.js
'use strict';
const path = require('path');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

async function main() {
  process.env.PORT = '0'; // let the OS pick a free port
  const server = require(path.join(__dirname, '..', 'server.js'));
  await new Promise((resolve) => server.once('listening', resolve)).catch(() => {});
  // server.js calls listen() synchronously at require time; if it's already listening by
  // the time we get here (likely, since require() is synchronous and listen() fires soon
  // after), the 'listening' event may have already fired — guard with a short wait instead.
  await new Promise((r) => setTimeout(r, 50));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function api(method, urlPath, body) {
    const res = await fetch(base + urlPath, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  // ---- create a 2-player room ----
  const created = await api('POST', '/api/rooms', { hostName: 'Alice', capacity: 2, homerunMode: false });
  assert(created.status === 201, 'creating a room returns 201');
  assert(typeof created.json.room.code === 'string' && created.json.room.code.length >= 4, 'the created room has a shareable code');
  assert(created.json.room.phase === 'lobby', 'a freshly created room starts in the lobby phase');
  assert(created.json.room.players.length === 1, 'the host is seated alone in a brand-new room');
  const code = created.json.room.code;
  const hostId = created.json.playerId;

  // ---- dealing before the room is full is rejected ----
  const dealTooSoon = await api('POST', `/api/rooms/${code}/deal`, { playerId: hostId });
  assert(dealTooSoon.status === 409, 'dealing before the room is full is rejected (409)');

  // ---- a bogus room code 404s ----
  const bogus = await api('GET', `/api/rooms/ZZZZZ?playerId=whatever`);
  assert(bogus.status === 404, 'a nonexistent room code returns 404');

  // ---- second player joins ----
  const joined = await api('POST', `/api/rooms/${code}/join`, { name: 'Bob' });
  assert(joined.status === 200, 'a second player can join an open room');
  assert(joined.json.room.players.length === 2, 'the room now shows 2 seated players');
  const bobId = joined.json.playerId;
  assert(joined.json.room.isHost === false, "the joining player's own view correctly says they are NOT the host");

  // ---- a third player is rejected once the room is full ----
  const thirdTriesToJoin = await api('POST', `/api/rooms/${code}/join`, { name: 'Cara' });
  assert(thirdTriesToJoin.status === 409, 'a third player cannot join a room that is already at capacity (409)');

  // ---- non-host cannot deal ----
  const nonHostDeal = await api('POST', `/api/rooms/${code}/deal`, { playerId: bobId });
  assert(nonHostDeal.status === 403, 'a non-host player cannot deal the hand (403)');

  // ---- host deals ----
  const dealt = await api('POST', `/api/rooms/${code}/deal`, { playerId: hostId });
  assert(dealt.status === 200, 'the host can deal once the room is full');
  assert(dealt.json.room.phase === 'arranging', 'dealing moves the room into the "arranging" phase');
  assert(Array.isArray(dealt.json.room.yourHand) && dealt.json.room.yourHand.length === 7, "the host's own view includes their own 7-card dealt hand");

  const bobView = await api('GET', `/api/rooms/${code}?playerId=${bobId}`);
  assert(Array.isArray(bobView.json.room.yourHand) && bobView.json.room.yourHand.length === 7, "Bob's own view includes HIS own 7-card dealt hand");
  assert(JSON.stringify(bobView.json.room.yourHand) !== JSON.stringify(dealt.json.room.yourHand), "the two players were dealt DIFFERENT hands (not shown the same 7 cards)");
  assert(bobView.json.room.players.every((p) => p.assignment === null), "nobody's hand split is visible to anyone yet (hands aren't tabled until everyone is ready)");

  // ---- joining is rejected once the hand has already started ----
  const lateJoin = await api('POST', `/api/rooms/${code}/join`, { name: 'Late' });
  assert(lateJoin.status === 409, 'joining a room that has already dealt is rejected (409)');

  // ---- a malformed/incomplete split is rejected ----
  const hostHand = dealt.json.room.yourHand;
  const badSplit = await api('POST', `/api/rooms/${code}/submit`, {
    playerId: hostId,
    assignment: { one: [hostHand[0], hostHand[1]], two: [hostHand[2]], four: hostHand.slice(3, 7) }
  });
  assert(badSplit.status === 400, 'submitting a wrong-sized split is rejected (400)');

  // ---- host submits a legal split; room should NOT move to "sweat" yet (Bob isn't ready) ----
  const hostSplit = { one: [hostHand[0]], two: hostHand.slice(1, 3), four: hostHand.slice(3, 7) };
  const hostSubmit = await api('POST', `/api/rooms/${code}/submit`, { playerId: hostId, assignment: hostSplit });
  assert(hostSubmit.status === 200, "the host's legal split is accepted");
  assert(hostSubmit.json.room.phase === 'arranging', 'the room stays in "arranging" until EVERY seat is ready, not just one');

  // Bob's view right now still must not reveal the host's completed split — otherwise
  // someone could finish early and leak their own hand to a slower player before showdown.
  const bobViewMidway = await api('GET', `/api/rooms/${code}?playerId=${bobId}`);
  const hostPlayerInBobView = bobViewMidway.json.room.players.find((p) => p.id === hostId);
  assert(hostPlayerInBobView.assignment === null, "the host's hand split stays hidden from Bob even after the host is ready, until EVERYONE is ready");
  assert(hostPlayerInBobView.ready === true, "Bob's view DOES show that the host has readied up (just not what they submitted)");

  // ---- Bob submits; now both are ready, hands get tabled, sweat begins ----
  const bobHand = bobView.json.room.yourHand;
  const bobSplit = { one: [bobHand[0]], two: bobHand.slice(1, 3), four: bobHand.slice(3, 7) };
  const bobSubmit = await api('POST', `/api/rooms/${code}/submit`, { playerId: bobId, assignment: bobSplit });
  assert(bobSubmit.status === 200, "Bob's legal split is accepted");
  assert(bobSubmit.json.room.phase === 'sweat', 'once every seat is ready, the room moves into the "sweat" phase');
  assert(JSON.stringify(bobSubmit.json.room.players.find((p) => p.id === hostId).assignment) === JSON.stringify(hostSplit),
    "once hands are tabled (sweat phase), Bob's view DOES show the host's full split");
  assert(bobSubmit.json.room.stage === 'flops', 'the sweat starts at the "flops" stage');
  assert(bobSubmit.json.room.boardA.length === 0 && bobSubmit.json.room.boardB.length === 0, 'no board cards are visible yet at the very start of the sweat');

  // ---- non-host cannot advance the reveal ----
  const nonHostAdvance = await api('POST', `/api/rooms/${code}/advance`, { playerId: bobId, action: 'flops' });
  assert(nonHostAdvance.status === 403, 'a non-host player cannot advance the board reveal (403)');

  // ---- advancing out of order is rejected ----
  const outOfOrder = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'turnA' });
  assert(outOfOrder.status === 409, 'trying to reveal a later stage before the current one is rejected (409)');

  // ---- host advances through flops, turnA, turnB ----
  const afterFlops = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'flops' });
  assert(afterFlops.status === 200 && afterFlops.json.room.boardA.length === 3 && afterFlops.json.room.boardB.length === 3,
    'revealing "flops" shows exactly 3 cards on each board');
  assert(afterFlops.json.room.stage === 'turnA', 'after the flops, the next stage is "turnA"');

  const afterTurnA = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'turnA' });
  assert(afterTurnA.json.room.boardA.length === 4, 'revealing "turnA" brings board A to 4 known cards');

  const afterTurnB = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'turnB' });
  assert(afterTurnB.json.room.boardB.length === 4, 'revealing "turnB" brings board B to 4 known cards');
  assert(afterTurnB.json.room.stage === 'riverA', 'after both turns, the next stage is "riverA"');

  // ---- river-swing check for board A (server-computed, same for every viewer) ----
  const swingA = await api('POST', `/api/rooms/${code}/river-swing`, { playerId: hostId, board: 0 });
  assert(swingA.status === 200, 'the host can request the river-A swing/outs check');
  assert(typeof swingA.json.room.pendingSwing === 'object' && swingA.json.room.pendingSwing.boardIndex === 0,
    'the swing check result is stored on the room as pendingSwing for board A');
  const swingAForBob = await api('GET', `/api/rooms/${code}?playerId=${bobId}`);
  assert(JSON.stringify(swingAForBob.json.room.pendingSwing) === JSON.stringify(swingA.json.room.pendingSwing),
    "Bob's poll sees the EXACT SAME swing/outs result the host computed, not a separately-rolled one");

  // ---- checking the swing for the wrong board/stage is rejected ----
  const wrongBoardSwing = await api('POST', `/api/rooms/${code}/river-swing`, { playerId: hostId, board: 1 });
  assert(wrongBoardSwing.status === 409, 'checking the river-B swing while still on the river-A stage is rejected (409)');

  // ---- complete both rivers ----
  const afterRiverA = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'riverA' });
  assert(afterRiverA.json.room.boardA.length === 5, 'revealing "riverA" brings board A to its full 5 cards');
  assert(afterRiverA.json.room.pendingSwing === null, 'completing the river clears the pending swing/outs info');
  assert(afterRiverA.json.room.stage === 'riverB', 'after river A, the next stage is "riverB"');

  const afterRiverB = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'riverB' });
  assert(afterRiverB.json.room.boardB.length === 5, 'revealing "riverB" brings board B to its full 5 cards');
  assert(afterRiverB.json.room.stage === 'done', 'after both rivers, the stage is "done"');

  // ---- nothing left to advance ----
  const nothingLeft = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'done' });
  assert(nothingLeft.status === 409, 'trying to advance again once the hand is fully revealed is rejected (409)');

  // ---- scoring is derivable client-side from the now-fully-visible state: zero-sum check ----
  const G = require(path.join(__dirname, '..', 'lib', 'game.js'));
  const finalPlayers = [
    { id: hostId, name: 'Alice', assignment: hostSplit },
    { id: bobId, name: 'Bob', assignment: bobSplit }
  ];
  const finalResult = G.computeResults(finalPlayers, [afterRiverB.json.room.boardA, afterRiverB.json.room.boardB], false);
  const sum = Object.values(finalResult.pointsByPlayer).reduce((a, b) => a + b, 0);
  assert(sum === 0, 'the fully-revealed hand, scored the same way the client will, is zero-sum');

  // ---- host starts a new hand; room resets to the lobby, keeping the same two seats ----
  const nonHostNewHand = await api('POST', `/api/rooms/${code}/new-hand`, { playerId: bobId });
  assert(nonHostNewHand.status === 403, 'a non-host player cannot start a new hand (403)');

  const newHand = await api('POST', `/api/rooms/${code}/new-hand`, { playerId: hostId });
  assert(newHand.status === 200 && newHand.json.room.phase === 'lobby', '"New Hand" returns the room to the lobby phase');
  assert(newHand.json.room.players.length === 2, 'the same two seats are still in the room after a new hand is started');
  assert(newHand.json.room.players.every((p) => p.ready === false), 'both players are reset to not-ready for the new hand');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
