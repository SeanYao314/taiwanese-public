// tests/ui_sim.test.js — headless DOM simulation of public/client.js using jsdom.
// Playwright's browser tool is network-blocked in this environment (every real
// navigation, even to localhost or example.com, fails with ERR_BLOCKED_BY_CLIENT),
// so this harness drives the ACTUAL client.js/index.html/style.css against a real
// (if headless) DOM and event loop instead of hand-reading the code for bugs.
// Run with: node tests/ui_sim.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Poll instead of guessing a fixed delay — computeStageEquity's cost varies a lot (player
// count, how much of the board is known), so a fixed sleep is either flaky or wastes time.
async function waitUntil(conditionFn, { timeout = 8000, interval = 25 } = {}) {
  const start = Date.now();
  while (!conditionFn()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil timed out after ' + timeout + 'ms');
    await sleep(interval);
  }
}

async function main() {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const pokerSrc = fs.readFileSync(path.join(root, 'lib', 'poker.js'), 'utf8');
  const gameSrc = fs.readFileSync(path.join(root, 'lib', 'game.js'), 'utf8');
  const equitySrc = fs.readFileSync(path.join(root, 'lib', 'equity.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(root, 'public', 'client.js'), 'utf8');

  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const consoleErrors = [];
  w.addEventListener('error', (e) => { consoleErrors.push(e.error ? (e.error.stack || e.error.message) : e.message); });

  // Load the three UMD libs then the client script, in the same order index.html does.
  w.eval(pokerSrc);
  w.eval(gameSrc);
  w.eval(equitySrc);
  assert(typeof w.Poker === 'object' && typeof w.Game === 'object' && typeof w.Equity === 'object',
    'lib/poker.js, lib/game.js, lib/equity.js all attach to window when loaded as plain <script> tags (not just require())');
  w.eval(clientSrc);
  await sleep(10);
  assert(consoleErrors.length === 0, `client.js loads and runs its setup-time code with zero uncaught errors, got: ${consoleErrors.join(' | ')}`);

  const doc = w.document;
  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => Array.from(doc.querySelectorAll(sel));
  function click(el) { el.dispatchEvent(new w.Event('click', { bubbles: true })); }

  // ---- setup screen: pick 3 players, deal ----
  const pill3 = $$('.pill-btn').find((b) => b.dataset.count === '3');
  click(pill3);
  assert($$('#playerNameInputs input').length === 3, 'switching the player-count pill to 3 regenerates exactly 3 name inputs');
  const nameInputs = $$('#playerNameInputs input');
  nameInputs[0].value = 'Alice'; nameInputs[0].dispatchEvent(new w.Event('input', { bubbles: true }));
  nameInputs[1].value = 'Bob'; nameInputs[1].dispatchEvent(new w.Event('input', { bubbles: true }));
  nameInputs[2].value = 'Cara'; nameInputs[2].dispatchEvent(new w.Event('input', { bubbles: true }));

  click($('#btnDeal'));
  await sleep(5);
  assert($('#preDealPanel').classList.contains('hidden'), 'dealing hides the pre-deal panel');
  assert(!$('#arrangePanel').classList.contains('hidden'), 'dealing reveals the arrange panel');
  assert($$('.player-tab').length === 3, 'three player tabs are rendered after dealing to 3 players');
  assert($$('#arrangerBody .tray-cards .card').length === 7, "the active player's tray starts with all 7 dealt cards");

  // ---- arrange all 3 players: 1 card to "one", 2 to "two", 4 to "four" ----
  function arrangeActivePlayer() {
    // "one" zone is active by default
    let trayCards = $$('#arrangerBody .tray-cards .card');
    click(trayCards[0]); // -> one (1/1)
    const twoBtn = $$('#arrangerBody .zone-btn').find((b) => b.textContent.includes('2-Card'));
    click(twoBtn);
    trayCards = $$('#arrangerBody .tray-cards .card');
    click(trayCards[0]);
    trayCards = $$('#arrangerBody .tray-cards .card');
    click(trayCards[0]); // two more -> two (2/2)
    const fourBtn = $$('#arrangerBody .zone-btn').find((b) => b.textContent.includes('4-Card'));
    click(fourBtn);
    for (let i = 0; i < 4; i++) {
      trayCards = $$('#arrangerBody .tray-cards .card');
      click(trayCards[0]);
    }
  }

  for (let p = 0; p < 3; p++) {
    arrangeActivePlayer();
    assert($$('#arrangerBody .tray-cards .card').length === 0, `player ${p + 1}: tray is empty once all 7 cards are placed (1+2+4)`);
    assert($$('.player-tab')[p].classList.contains('valid'), `player ${p + 1}'s tab is marked valid once their split is complete and legal`);
    if (p < 2) click($$('.player-tab')[p + 1]);
  }

  assert(!$('#btnSweat').disabled, '"Sweat It Out" becomes enabled once every player has a valid, complete split');

  // placed-card click returns a card to the tray (test on whichever player tab is active, player 3).
  // The FIRST .slot-cards in DOM order is the "one" zone (1 card), not whatever zone was last
  // active — removing it should automatically make "one" the active zone again, so the freed
  // slot is immediately where the next tray tap lands (this is the behavior under test).
  const placedCard = $('#arrangerBody .slot-cards .card');
  assert(!!placedCard, 'a placed card element exists in the current player\'s slots to test removal');
  click(placedCard);
  assert($$('#arrangerBody .tray-cards .card').length === 1, 'clicking a placed card removes it from its zone and returns exactly one card to the tray');
  assert($$('.player-tab')[2].classList.contains('valid') === false, 'removing a placed card makes that player invalid again (incomplete split)');
  assert($('#btnSweat').disabled, '"Sweat It Out" is disabled again while any player is incomplete');
  const oneBtnActive = $$('#arrangerBody .zone-btn').find((b) => b.textContent.includes('1-Card'));
  assert(oneBtnActive.classList.contains('active'), 'removing a card from the "one" zone automatically re-activates the "one" zone');
  // put it back (click the lone tray card; "one" is now active again thanks to the fix above)
  click($$('#arrangerBody .tray-cards .card')[0]);
  assert($('#btnSweat').disabled === false, 're-placing the card makes the player valid and re-enables "Sweat It Out" again');

  // ---- enter the sweat screen ----
  click($('#btnSweat'));
  await waitUntil(() => !$('#sweatScreen').classList.contains('hidden'));
  assert($('#setupScreen').classList.contains('hidden'), 'entering the sweat screen hides the setup screen');
  assert(!$('#sweatScreen').classList.contains('hidden'), 'entering the sweat screen un-hides the sweat screen');
  assert($$('#boardACards .card-back').length === 5 && $$('#boardBCards .card-back').length === 5,
    'both boards start fully face-down (5 backs each) before any reveal');
  assert($$('.hand-card-box').length === 3, 'the hands panel shows all 3 players\' arranged hands during the sweat');

  // ---- stage 1: flops ----
  let revealBtn = $('#revealControls button');
  assert(!!revealBtn && revealBtn.textContent.includes('Reveal Both Flops'), 'the first reveal control is "Reveal Both Flops"');
  click(revealBtn);
  await waitUntil(() => $('#equityPanel').textContent.includes('Win'));
  assert($$('#boardACards .card').length === 3 && $$('#boardBCards .card').length === 3,
    'clicking "Reveal Both Flops" reveals exactly 3 cards on EACH board simultaneously');
  assert($('#equityPanel').innerHTML.includes('Win'), 'the equity panel renders win% once the flops are known');
  assert($$('.equity-row').length === 3, 'the equity panel shows one row per player (3 players)');

  // ---- stage 2 & 3: turns ----
  revealBtn = $('#revealControls button');
  assert(revealBtn.className.includes('reveal-card-btn'), 'after the flops, the next control is a plain reveal button (turn A)');
  click(revealBtn);
  await waitUntil(() => $$('#boardACards .card').length === 4);
  await waitUntil(() => !$('#equityPanel').textContent.includes('odds…'));
  assert($$('#boardACards .card').length === 4, 'turn A reveal brings board A up to 4 known cards');

  revealBtn = $('#revealControls button');
  click(revealBtn);
  await waitUntil(() => $$('#boardBCards .card').length === 4);
  await waitUntil(() => !$('#equityPanel').textContent.includes('odds…'));
  assert($$('#boardBCards .card').length === 4, 'turn B reveal brings board B up to 4 known cards');

  // ---- stage 4: river A (swing check happens first) ----
  // The swing check (computeRiverSwing) can resolve purely on microtasks when its candidate
  // pool is small, with no macrotask gap at all — so polling for a transient "checking..."
  // message is unreliable (it can appear and clear within a single macrotask turn, before any
  // setTimeout-based poll ever observes it). Instead, confirm we've moved past the PREVIOUS
  // stage's button by reference (not just by CSS class, since the new button has the same
  // class) before trusting whatever reveal-card-btn / peel-card we find next.
  await waitUntil(() => !doc.contains(revealBtn) && (!!$('.peel-card') || !!$('#revealControls .reveal-card-btn')));
  const hasPeel = !!$('.peel-card');
  const hasPlainRiverBtn = !!$('#revealControls .reveal-card-btn');
  assert(hasPeel || hasPlainRiverBtn, 'river A renders either a peel-card (swing) or a plain reveal button (no swing), never neither');
  console.log('river A control type:', hasPeel ? 'peel (swing detected)' : 'plain button (no swing)');

  let riverAControlNode; // whichever element river A's control turns out to be, used below to
  // detect "we've moved past this" the same reference-based way, instead of racing a transient
  // status message.
  if (hasPeel) {
    const peel = $('.peel-card');
    riverAControlNode = peel;
    assert(!$('#outsPanel').classList.contains('hidden'), 'when a peel card is shown for a swingy river, the outs panel is visible');
    // simulate a full hold-to-peel: pointerdown, wait past the reveal duration, then release
    peel.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    await waitUntil(() => peel.classList.contains('locked'), { timeout: 4000 });
    assert(peel.classList.contains('locked'), 'holding the peel card past its full duration locks it revealed');
    await waitUntil(() => $$('#boardACards .card').length === 5);
    assert($$('#boardACards .card').length === 5, 'completing the peel on river A reveals the 5th board-A card in the board display');
    assert($('#outsPanel').classList.contains('hidden'), 'the outs panel hides again once the swingy river is fully revealed');
  } else {
    // snap-back check: press and release early, card must NOT reveal
    const btn = $('#revealControls .reveal-card-btn');
    riverAControlNode = btn;
    assert($('#outsPanel').classList.contains('hidden'), 'when no swing is detected on river A, the outs panel stays hidden');
    click(btn);
    await waitUntil(() => $$('#boardACards .card').length === 5);
    assert($$('#boardACards .card').length === 5, 'clicking the plain reveal button reveals the 5th board-A card');
  }
  await waitUntil(() => !$('#equityPanel').textContent.includes('odds…'));

  // ---- stage 5: river B ----
  await waitUntil(() => !doc.contains(riverAControlNode) && (!!$('.peel-card') || !!$('#revealControls .reveal-card-btn')));
  const hasPeelB = !!$('.peel-card');
  const hasPlainBtnB = !!$('#revealControls .reveal-card-btn');
  assert(hasPeelB || hasPlainBtnB, 'river B also renders either a peel-card or a plain reveal button');
  console.log('river B control type:', hasPeelB ? 'peel (swing detected)' : 'plain button (no swing)');

  if (hasPeelB) {
    const peelB = $('.peel-card');
    // this time, release EARLY and confirm it snaps back (does not lock, does not reveal)
    peelB.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
    await sleep(200);
    peelB.dispatchEvent(new w.PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
    await sleep(400); // snap-back animation is time-based (220ms), not state we can poll for completion of "nothing happening"
    assert(!peelB.classList.contains('locked'), 'releasing the peel card early (before full duration) does NOT lock it revealed');
    assert($$('#boardBCards .card').length === 4, 'an early release leaves board B still at 4 known cards (river not actually revealed)');
    // now hold it fully through to completion
    peelB.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId: 3 }));
    await waitUntil(() => peelB.classList.contains('locked'), { timeout: 4000 });
    assert(peelB.classList.contains('locked'), 'holding the peel card fully through now locks it revealed');
    await waitUntil(() => $$('#boardBCards .card').length === 5);
    assert($$('#boardBCards .card').length === 5, 'completing the peel on river B reveals the 5th board-B card');
  } else {
    const btnB = $('#revealControls .reveal-card-btn');
    click(btnB);
    await waitUntil(() => $$('#boardBCards .card').length === 5);
    assert($$('#boardBCards .card').length === 5, 'clicking the plain reveal button reveals the 5th board-B card');
  }

  // ---- showdown ----
  await waitUntil(() => $('#revealControls').textContent.includes('Showdown complete'));
  assert($('#revealControls').textContent.includes('Showdown complete'), 'after both rivers are revealed, the controls area announces the showdown is complete');
  assert($$('.equity-row').length === 3, 'the final equity panel still shows one settled row per player');
  const finalEquityText = $('#equityPanel').textContent;
  assert(finalEquityText.includes('Win 100.0%') || finalEquityText.includes('Win 0.0%') || finalEquityText.includes('Win 50.0%'),
    'the final (fully-determined) equity numbers look like settled results, not probabilistic estimates');
  assert(consoleErrors.length === 0, `no uncaught errors occurred at any point during the full setup->sweat->showdown flow, got: ${consoleErrors.join(' | ')}`);

  // ---- New Hand resets back to setup ----
  click($('#btnNewHand'));
  assert($('#sweatScreen').classList.contains('hidden') && !$('#setupScreen').classList.contains('hidden'),
    '"New Hand" returns to the setup screen');
  assert(!$('#preDealPanel').classList.contains('hidden'), '"New Hand" shows the pre-deal panel again, ready for a fresh deal');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
