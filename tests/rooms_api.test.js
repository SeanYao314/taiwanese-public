// tests/rooms_api.test.js — exercises the real multiplayer server (server.js + lib/rooms.js)
// over actual HTTP, simulating two separate browsers (two players) hitting the JSON API.
// This is the piece that makes "send someone the link" work, so it gets tested as the real
// request/response cycle a browser would drive, not just by calling lib/rooms.js functions
// directly — in particular, it proves hidden information actually stays hidden across the
// wire (one player's view of room state never contains another player's cards until hands
// are tabled), that the board reveal paces itself automatically with no client action, and
// that the one remaining host-only action (completing the squeeze on a swing river) is
// rejected for everyone else and for the wrong stage.
// Run with: node tests/rooms_api.test.js
'use strict';
const path = require('path');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(conditionFn, timeout = 5000) {
  const start = Date.now();
  while (!(await conditionFn())) {
    if (Date.now() - start > timeout) throw new Error('waitUntil timed out after ' + timeout + 'ms');
    await sleep(10);
  }
}

async function main() {
  process.env.PORT = '0'; // let the OS pick a free port
  // Shrinks the server's own auto-pacing hold times (1000/2500ms -> 15ms) so this test
  // doesn't spend 10+ real seconds waiting out the dramatic pacing on purpose.
  process.env.SWEAT_ROOM_FAST_TIMERS = '1';
  const server = require(path.join(__dirname, '..', 'server.js'));
  await new Promise((resolve) => server.once('listening', resolve)).catch(() => {});
  // server.js calls listen() synchronously at require time; if it's already listening by
  // the time we get here (likely, since require() is synchronous and listen() fires soon
  // after), the 'listening' event may have already fired — guard with a short wait instead.
  await sleep(50);
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
  async function view(code, playerId) {
    return (await api('GET', `/api/rooms/${code}?playerId=${playerId}`)).json.room;
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

  // ---- Bob submits; now both are ready, hands get tabled, and the automatic reveal
  // clock starts entirely on its own ----
  const bobHand = bobView.json.room.yourHand;
  const bobSplit = { one: [bobHand[0]], two: bobHand.slice(1, 3), four: bobHand.slice(3, 7) };
  const bobSubmit = await api('POST', `/api/rooms/${code}/submit`, { playerId: bobId, assignment: bobSplit });
  assert(bobSubmit.status === 200, "Bob's legal split is accepted");
  assert(bobSubmit.json.room.phase === 'sweat', 'once every seat is ready, the room moves into the "sweat" phase');
  assert(JSON.stringify(bobSubmit.json.room.players.find((p) => p.id === hostId).assignment) === JSON.stringify(hostSplit),
    "once hands are tabled (sweat phase), Bob's view DOES show the host's full split");
  assert(bobSubmit.json.room.stage === 'flops', 'the sweat starts at the "flops" stage');
  assert(bobSubmit.json.room.boardA.length === 0 && bobSubmit.json.room.boardB.length === 0, 'no board cards are visible yet at the very start of the sweat');

  // ---- non-host can never call advance, even before anything is pending ----
  const nonHostAdvance = await api('POST', `/api/rooms/${code}/advance`, { playerId: bobId, action: 'flops' });
  assert(nonHostAdvance.status === 403, 'a non-host player cannot call advance (403)');

  // ---- advance is rejected for a stage that reveals itself automatically ----
  const autoStageAdvance = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'flops' });
  assert(autoStageAdvance.status === 409, 'advance is rejected for "flops" — it reveals itself automatically, there is nothing to complete (409)');

  // ---- the board reveals itself automatically: both flops, then both turns — no client
  // action of any kind ----
  await waitUntil(async () => {
    const room = await view(code, hostId);
    return room.boardA.length >= 3 && room.boardB.length >= 3;
  });
  let room = await view(code, hostId);
  assert(room.boardA.length === 3 && room.boardB.length === 3, 'both flops reveal automatically to exactly 3 cards each, with no client action');

  await waitUntil(async () => (await view(code, hostId)).boardA.length >= 4);
  await waitUntil(async () => (await view(code, hostId)).boardB.length >= 4);
  room = await view(code, hostId);
  assert(room.boardA.length === 4 && room.boardB.length === 4, 'both turns reveal automatically, bringing each board to 4 known cards');

  // Bob's own poll sees the identical, server-authoritative board.
  const bobTurnView = await view(code, bobId);
  assert(JSON.stringify(bobTurnView.boardA) === JSON.stringify(room.boardA) && JSON.stringify(bobTurnView.boardB) === JSON.stringify(room.boardB),
    "Bob's poll sees the EXACT same board cards as the host's — one shared authoritative board");

  // ---- rivers: each one either completes itself automatically (no swing), or stops and
  // waits — indefinitely — for the host to complete the squeeze (swing detected) ----
  async function driveRiver() {
    room = await view(code, hostId);
    if (room.boardA.length === 5 && room.boardB.length === 5) return; // raced to 'done' already
    // Track growth from THIS call's starting point, not an absolute "===5" — otherwise a
    // board that already hit 5 on a PREVIOUS river (riverA) would make this call's wait for
    // riverB resolve immediately, before riverB's own swing check has even run.
    const beforeA = room.boardA.length;
    const beforeB = room.boardB.length;
    await waitUntil(async () => {
      room = await view(code, hostId);
      return room.boardA.length > beforeA || room.boardB.length > beforeB || (room.pendingSwing && room.pendingSwing.hasSwing);
    });
    if (!room.pendingSwing || !room.pendingSwing.hasSwing) return; // this river had no swing and auto-completed
    const stage = room.stage; // 'riverA' or 'riverB'
    const otherStage = stage === 'riverA' ? 'riverB' : 'riverA';

    // Bob's poll sees the EXACT SAME swing/outs result the server computed once, not a
    // separately-rolled one.
    const bobDuringSwing = await view(code, bobId);
    assert(JSON.stringify(bobDuringSwing.pendingSwing) === JSON.stringify(room.pendingSwing),
      "Bob's poll sees the EXACT SAME swing/outs result the server computed, not a separately-rolled one");

    const nonHostSqueeze = await api('POST', `/api/rooms/${code}/advance`, { playerId: bobId, action: stage });
    assert(nonHostSqueeze.status === 403, `a non-host player cannot complete the squeeze on ${stage} (403)`);

    const wrongStageSqueeze = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: otherStage });
    assert(wrongStageSqueeze.status === 409, `completing the squeeze for ${otherStage} while actually on ${stage} is rejected (409)`);

    const squeeze = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: stage });
    assert(squeeze.status === 200, `the host can complete the squeeze on ${stage}`);
    assert(squeeze.json.room.pendingSwing === null, 'completing the squeeze clears the pending swing/outs info');
  }
  await driveRiver();
  await driveRiver();

  await waitUntil(async () => (await view(code, hostId)).stage === 'done');
  room = await view(code, hostId);
  assert(room.boardA.length === 5 && room.boardB.length === 5, 'both rivers end up fully revealed');
  assert(room.stage === 'done', 'once both rivers are in, the stage is "done"');

  // ---- nothing left to advance ----
  const nothingLeft = await api('POST', `/api/rooms/${code}/advance`, { playerId: hostId, action: 'done' });
  assert(nothingLeft.status === 409, 'trying to advance again once the hand is fully revealed is rejected (409)');

  // ---- scoring is derivable client-side from the now-fully-visible state: zero-sum check ----
  const G = require(path.join(__dirname, '..', 'lib', 'game.js'));
  const finalPlayers = [
    { id: hostId, name: 'Alice', assignment: hostSplit },
    { id: bobId, name: 'Bob', assignment: bobSplit }
  ];
  const finalResult = G.computeResults(finalPlayers, [room.boardA, room.boardB], false);
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
