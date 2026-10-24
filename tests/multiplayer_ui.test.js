// tests/multiplayer_ui.test.js — the real test of "can I send someone a link and play
// together": spins up the ACTUAL server.js (so lib/rooms.js, the real HTTP API, and timing
// are all real), then drives TWO separate, independent jsdom windows — one for the host,
// one for a guest on a different "device" — each loading the real public/index.html +
// client.js and talking to the server over real fetch() calls, exactly like two different
// browsers would. This is what actually proves multiplayer works end to end: a room code
// the host creates, a guest joining it, each of them seeing ONLY their own 7 cards while
// arranging, hands getting tabled once both are ready, and the server's own automatic
// flop/turn/river pacing mirroring over to both screens via polling — with the one
// exception that still needs a human: the host physically completing the drag-squeeze on
// a river the server flags as a swing spot.
// Run with: node tests/multiplayer_ui.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(conditionFn, { timeout = 10000, interval = 50 } = {}) {
  const start = Date.now();
  while (!conditionFn()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil timed out after ' + timeout + 'ms');
    await sleep(interval);
  }
}

async function main() {
  const root = path.join(__dirname, '..');
  process.env.PORT = '0';
  // Shrinks the server's auto-pacing hold times (1000/2500ms -> 15ms) so this test doesn't
  // spend 10+ real seconds waiting out the dramatic pacing on purpose — same mechanism the
  // rooms_api test uses.
  process.env.SWEAT_ROOM_FAST_TIMERS = '1';
  const server = require(path.join(root, 'server.js'));
  await sleep(50);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const pokerSrc = fs.readFileSync(path.join(root, 'lib', 'poker.js'), 'utf8');
  const gameSrc = fs.readFileSync(path.join(root, 'lib', 'game.js'), 'utf8');
  const equitySrc = fs.readFileSync(path.join(root, 'lib', 'equity.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(root, 'public', 'client.js'), 'utf8');

  // Builds one independent "browser" (its own window, its own localStorage, its own
  // in-flight timers) pointed at the real server over real HTTP — exactly as separate as
  // two different people's devices opening the same link would be.
  function makeBrowser(label) {
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: base + '/' });
    const w = dom.window;
    const errors = [];
    w.addEventListener('error', (e) => { errors.push(e.error ? (e.error.stack || e.error.message) : e.message); });
    // jsdom doesn't implement fetch itself — proxy to Node's real global fetch, resolving
    // relative URLs against this window's (real) location, same as a real browser would.
    w.fetch = (url, opts) => fetch(new URL(url, w.location.href).toString(), opts);
    // Matches the server's own SWEAT_ROOM_FAST_TIMERS speed-up — also shrinks the client's
    // mp poll interval (see client.js's MP_POLL_MS) so it actually has a chance to observe
    // the server's now-millisecond-paced automatic stages instead of racing straight past
    // all of them to 'done' between 1200ms production-cadence polls.
    w.__SWEAT_ROOM_FAST_TIMERS__ = true;
    w.eval(pokerSrc);
    w.eval(gameSrc);
    w.eval(equitySrc);
    w.eval(clientSrc);
    const doc = w.document;
    return {
      label, w, doc, errors,
      $: (sel) => doc.querySelector(sel),
      $$: (sel) => Array.from(doc.querySelectorAll(sel)),
      click(elm) { elm.dispatchEvent(new w.Event('click', { bubbles: true })); },
      setValue(elm, val) { elm.value = val; elm.dispatchEvent(new w.Event('input', { bubbles: true })); }
    };
  }

  const host = makeBrowser('host');
  const guest = makeBrowser('guest');
  await sleep(20);

  // ---- host: create a 2-player room ----
  host.click(host.$('#btnModeMultiplayer'));
  assert(!host.$('#mpScreen').classList.contains('hidden'), 'host: choosing multiplayer shows the mp screen');
  assert(!host.$('#mpCreatePanel').classList.contains('hidden'), 'host: the "Create a room" panel is the default tab');
  host.setValue(host.$('#mpHostName'), 'Alice');
  host.click(host.$('#mpCapacityGroup').querySelector('.pill-btn[data-count="2"]'));
  host.click(host.$('#btnMpCreate'));
  await waitUntil(() => !host.$('#mpLobbyPanel').classList.contains('hidden'));
  const roomCode = host.$('#mpRoomCode').textContent.trim();
  assert(/^[A-Z0-9]{4,}$/.test(roomCode), `host: a room code is generated and shown (got "${roomCode}")`);
  assert(host.$('#mpShareLink').value.includes(`room=${roomCode}`), 'host: the share-link field contains a URL with the room code in it');
  assert(host.$('#btnMpDeal').disabled, 'host: "Deal Hands" is disabled while the room is not yet full');

  // ---- guest: join using the code ----
  guest.click(guest.$('#btnModeMultiplayer'));
  guest.click(guest.$('#mpEntryTabs').querySelector('.pill-btn[data-tab="join"]'));
  assert(!guest.$('#mpJoinPanel').classList.contains('hidden'), 'guest: switching to the "Join a room" tab reveals the join form');
  guest.setValue(guest.$('#mpJoinName'), 'Bob');
  guest.setValue(guest.$('#mpJoinCode'), roomCode.toLowerCase()); // lowercase on purpose — should still work
  guest.click(guest.$('#btnMpJoin'));
  await waitUntil(() => !guest.$('#mpLobbyPanel').classList.contains('hidden'));
  assert(guest.$$('#mpSeatList .player-tab').length === 2, "guest: the lobby immediately shows both seats (host + self) from the join response");
  assert(guest.$('#btnMpDeal').classList.contains('hidden'), 'guest: the non-host guest never sees a "Deal Hands" button at all');

  // host's poll should pick up the second seat within a couple of ticks
  await waitUntil(() => !host.$('#btnMpDeal').disabled, { timeout: 5000 });
  assert(!host.$('#btnMpDeal').disabled, "host: once Bob joins, the host's own poll enables \"Deal Hands\"");

  // ---- host deals ----
  host.click(host.$('#btnMpDeal'));
  await waitUntil(() => !host.$('#mpArrangePanel').classList.contains('hidden'));
  const hostTray = () => host.$$('#mpArrangerBody .tray .playing-card');
  assert(hostTray().length === 7, "host: dealing reveals the host's own 7-card tray");

  await waitUntil(() => !guest.$('#mpArrangePanel').classList.contains('hidden'), { timeout: 5000 });
  const guestTray = () => guest.$$('#mpArrangerBody .tray .playing-card');
  assert(guestTray().length === 7, "guest: the guest's own poll picks up the deal and shows THEIR own 7-card tray");

  const hostCards = hostTray().map((c) => c.dataset.card).sort().join(',');
  const guestCards = guestTray().map((c) => c.dataset.card).sort().join(',');
  assert(hostCards !== guestCards, 'privacy: the host and guest were dealt genuinely different hands, each seeing only their own');

  // ---- both arrange: 1 card -> one, 2 -> two, 4 -> four (via Ctrl+click quick-place) ----
  function arrange(b) {
    function slot(zone) { return b.$(`#mpArrangerBody .slot[data-slot="${zone}"]`); }
    let tray = b.$$('#mpArrangerBody .tray .playing-card');
    b.click(tray[0]);
    b.click(slot('one'));
    for (let i = 0; i < 2; i++) {
      tray = b.$$('#mpArrangerBody .tray .playing-card');
      b.click(tray[0]);
      b.click(slot('two'));
    }
    for (let i = 0; i < 4; i++) {
      tray = b.$$('#mpArrangerBody .tray .playing-card');
      tray[0].dispatchEvent(new b.w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
  }
  arrange(host);
  assert(host.$$('#mpArrangerBody .tray .playing-card').length === 0, "host: all 7 of the host's own cards are placed");
  assert(!host.$('#btnMpReady').disabled, 'host: "I\'m Ready" enables once the split is complete and legal');
  arrange(guest);
  assert(guest.$$('#mpArrangerBody .tray .playing-card').length === 0, "guest: all 7 of the guest's own cards are placed");
  assert(!guest.$('#btnMpReady').disabled, 'guest: "I\'m Ready" enables once the split is complete and legal');

  // ---- host readies up first; the table must NOT proceed until Bob is ready too ----
  host.click(host.$('#btnMpReady'));
  await sleep(200);
  assert(host.$('#sweatScreen').classList.contains('hidden'), "host: the sweat screen does NOT appear yet — Bob hasn't readied up");
  assert(host.$('#mpArrangeStatus').textContent.includes('1/2'), 'host: the status line shows 1 of 2 players ready');

  // ---- guest readies up second — this is what tips the table into the sweat phase, and
  // also kicks off the server's own automatic reveal clock ----
  guest.click(guest.$('#btnMpReady'));
  await waitUntil(() => !guest.$('#sweatScreen').classList.contains('hidden'));
  await waitUntil(() => !host.$('#sweatScreen').classList.contains('hidden'), { timeout: 5000 });
  assert(!host.$('#sweatScreen').classList.contains('hidden') && !guest.$('#sweatScreen').classList.contains('hidden'),
    'both the host (via its own submit response) and the guest (via polling) land on the sweat screen once everyone is ready');

  await waitUntil(() => host.$$('.compare-player-head').length === 2 && guest.$$('.compare-player-head').length === 2);
  assert(true, 'both windows render a 2-player side-by-side compare table once hands are tabled');

  // ---- nobody has a clickable reveal control for flop/turn — it's passive for EVERYONE,
  // host included, since the server paces it on its own ----
  assert(!host.$('#revealControls button'), 'host: no clickable reveal control exists — the flop/turn/river happen on their own');
  assert(!guest.$('#revealControls button'), 'guest: likewise, nothing to click');

  // ---- both flops reveal automatically; guest's poll should mirror it. With the server's
  // auto-pacing timers sped way up for this test, flop/turn/river can fly by in well under
  // a poll interval's worth of real time, so these waits use >= (progress has been made)
  // rather than === (caught at exactly this frame) — the "it's actually synchronized"
  // guarantee comes from comparing CARD VALUES once both sides have reached at least 3,
  // not from both sides pausing on the exact same stage at the exact same moment. ----
  await waitUntil(() => host.$$('#boardACards .playing-card').length >= 3 && host.$$('#boardBCards .playing-card').length >= 3);
  await waitUntil(() => guest.$$('#boardACards .playing-card').length >= 3 && guest.$$('#boardBCards .playing-card').length >= 3, { timeout: 5000 });
  assert(true, "guest's screen mirrors the host's automatic flop reveal within a couple of poll ticks");
  // and the actual card VALUES match between the two windows (same authoritative board) —
  // compare only the first 3 (the flop) since either side may have already moved further
  const hostFlopA = host.$$('#boardACards .playing-card').slice(0, 3).map((c) => c.dataset.card).join(',');
  const guestFlopA = guest.$$('#boardACards .playing-card').slice(0, 3).map((c) => c.dataset.card).join(',');
  assert(hostFlopA === guestFlopA && hostFlopA.length > 0, 'the flop board A cards are IDENTICAL on both screens (one shared authoritative board)');

  // ---- turns happen automatically too ----
  await waitUntil(() => host.$$('#boardACards .playing-card').length >= 4, { timeout: 5000 });
  await waitUntil(() => host.$$('#boardBCards .playing-card').length >= 4, { timeout: 5000 });
  await waitUntil(() => guest.$$('#boardACards .playing-card').length >= 4 && guest.$$('#boardBCards .playing-card').length >= 4, { timeout: 5000 });
  assert(true, "guest's board mirrors both automatic turn reveals");

  // ---- rivers — auto-complete on their own UNLESS the server flags a swing, in which case
  // only the HOST ever gets a squeeze trigger; the guest just watches ----
  async function doRiverMp() {
    // Fast timers can race both rivers to completion before we even get a chance to look —
    // if so, there's nothing left to do here (no-op), since waiting for further "growth"
    // beyond an already-maxed-out 5 cards would never resolve.
    if (host.$$('#boardACards .playing-card').length === 5 && host.$$('#boardBCards .playing-card').length === 5) return;
    const beforeA = host.$$('#boardACards .playing-card').length;
    const beforeB = host.$$('#boardBCards .playing-card').length;
    await waitUntil(() => host.$$('#boardACards .playing-card').length > beforeA
      || host.$$('#boardBCards .playing-card').length > beforeB
      || !!host.$('.squeeze-trigger'), { timeout: 5000 });
    const trigger = host.$('.squeeze-trigger');
    if (trigger) {
      assert(!host.$('#outsPanel').classList.contains('hidden'), 'host: a swing river shows the outs panel');
      assert(!guest.$('.squeeze-trigger'), 'guest: the non-host guest never gets a squeeze trigger, even on a swing river');
      await waitUntil(() => !guest.$('#outsPanel').classList.contains('hidden'), { timeout: 5000 });
      assert(guest.$('#outsPanel').innerHTML === host.$('#outsPanel').innerHTML,
        "river: the guest's outs panel shows the EXACT same server-computed outs as the host's");
      assert(guest.$('#revealControls').textContent.toLowerCase().includes('squeezing'),
        'guest: sees a passive "...is squeezing..." message naming the host while the swing river is completed');
      host.click(trigger);
      await waitUntil(() => !!host.$('.squeeze-card'));
      const cardOuter = host.$('.squeeze-card');
      cardOuter.dispatchEvent(new host.w.PointerEvent('pointerdown', { bubbles: true, pointerId: 9, clientX: 0 }));
      host.w.dispatchEvent(new host.w.PointerEvent('pointermove', { clientX: 300 }));
      await waitUntil(() => !host.$('.squeeze-overlay'), { timeout: 3000 });
    }
    // else: this river had no swing and completed itself with no interaction needed.
  }
  await doRiverMp();
  await waitUntil(() => host.$$('#boardACards .playing-card').length === 5 || host.$$('#boardBCards .playing-card').length === 5, { timeout: 5000 });
  await doRiverMp();
  await waitUntil(() => host.$$('#boardACards .playing-card').length === 5 && host.$$('#boardBCards .playing-card').length === 5, { timeout: 5000 });
  await waitUntil(() => guest.$$('#boardACards .playing-card').length === 5 && guest.$$('#boardBCards .playing-card').length === 5, { timeout: 5000 });

  // ---- showdown on both screens ----
  await waitUntil(() => !host.$('#showdownExtras').classList.contains('hidden'));
  await waitUntil(() => !guest.$('#showdownExtras').classList.contains('hidden'), { timeout: 5000 });
  assert(host.$$('#scoreboard tr').length === 3, 'host: the scoreboard has a header row + 2 player rows for this 2-player room');
  assert(guest.$$('#scoreboard tr').length === 3, "guest: the guest's scoreboard matches (3 rows)");
  const hostTotals = host.$$('.compare-player-head .pscore').map((e) => parseInt(e.textContent, 10));
  const guestTotals = guest.$$('.compare-player-head .pscore').map((e) => parseInt(e.textContent, 10));
  assert(hostTotals.reduce((a, b) => a + b, 0) === 0, 'the final points are zero-sum on the host screen');
  assert(JSON.stringify(hostTotals.sort()) === JSON.stringify(guestTotals.sort()), 'the host and guest screens agree on the final point totals');

  // ---- New Hand: host resets the room; guest follows via polling ----
  const btnNewHand = host.$('#btnNewHand');
  assert(!btnNewHand.classList.contains('hidden'), 'host: "New Hand" is visible for the host');
  assert(guest.$('#btnNewHand').classList.contains('hidden'), 'guest: "New Hand" is hidden for a non-host — only the host can restart the table');
  host.click(btnNewHand);
  await waitUntil(() => !host.$('#mpLobbyPanel').classList.contains('hidden'));
  await waitUntil(() => !guest.$('#mpLobbyPanel').classList.contains('hidden'), { timeout: 5000 });
  assert(true, 'both windows return to the room lobby once the host starts a new hand, ready to deal again');

  assert(host.errors.length === 0, `host window: zero uncaught errors during the whole flow, got: ${host.errors.join(' | ')}`);
  assert(guest.errors.length === 0, `guest window: zero uncaught errors during the whole flow, got: ${guest.errors.join(' | ')}`);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
