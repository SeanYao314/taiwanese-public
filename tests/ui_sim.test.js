// tests/ui_sim.test.js — headless DOM simulation of public/client.js using jsdom.
// Playwright's browser tool is network-blocked in this environment (every real
// navigation, even to localhost or example.com, fails with ERR_BLOCKED_BY_CLIENT),
// so this harness drives the ACTUAL client.js/index.html/style.css against a real
// (if headless) DOM and event loop instead of hand-reading the code for bugs.
//
// This covers the rewritten UI: click-a-tray-card-then-click-a-slot arranging
// (matching the reference Taiwanese Poker project), the automatic (no-click)
// flop/turn/river pacing, the side-by-side compare table with live per-category
// win% badges, and the drag-based squeeze modal for swingy rivers.
//
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

  // Speed up the solo auto-pacing driver's timers (1000/2500ms -> 15ms) the same way the
  // server's own tests do via SWEAT_ROOM_FAST_TIMERS — otherwise this test would take 10+
  // real seconds per hand waiting out the dramatic pacing on purpose.
  w.__SWEAT_ROOM_FAST_TIMERS__ = true;

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

  // ---- mode screen: choose Solo ----
  assert(!$('#modeScreen').classList.contains('hidden'), 'the mode screen (Solo vs Multiplayer) is shown first, before anything else');
  assert($('#setupScreen').classList.contains('hidden'), 'the solo setup screen starts hidden until Solo is chosen');
  click($('#btnModeSolo'));
  assert($('#modeScreen').classList.contains('hidden'), 'choosing "Play Solo" hides the mode screen');
  assert(!$('#setupScreen').classList.contains('hidden'), 'choosing "Play Solo" reveals the solo setup screen');

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
  assert($$('.player-tab')[0].textContent.includes('Alice'), "the first player tab is labeled with the entered name 'Alice'");
  assert($$('#arrangerBody .tray .playing-card').length === 7, "the active player's tray starts with all 7 dealt cards");
  assert($$('#arrangerBody .slot').length === 3, 'the arranger shows exactly 3 hand-slot boxes (1-card, 2-card, 4-card PLO)');

  // ---- arrange all 3 players using the click-a-card-then-click-a-slot model ----
  // (click a tray card to select it, then click a slot box to place it there)
  function slotByZone(zone) { return $(`#arrangerBody .slot[data-slot="${zone}"]`); }

  function arrangeActivePlayer() {
    // place 1 card into "one": select the tray card, then click the "one" slot
    let tray = $$('#arrangerBody .tray .playing-card');
    click(tray[0]);
    // selecting re-renders the arranger (a whole new DOM subtree), so re-query rather than
    // trust the stale `tray[0]` reference from before the click.
    assert($$('#arrangerBody .tray .playing-card.selected').length === 1, 'clicking a tray card selects it (highlighted)');
    click(slotByZone('one'));

    // place 2 cards into "two"
    for (let i = 0; i < 2; i++) {
      tray = $$('#arrangerBody .tray .playing-card');
      click(tray[0]);
      click(slotByZone('two'));
    }

    // place the remaining 4 cards into "four" via Cmd/Ctrl+click quick-place
    for (let i = 0; i < 4; i++) {
      tray = $$('#arrangerBody .tray .playing-card');
      tray[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
  }

  for (let p = 0; p < 3; p++) {
    arrangeActivePlayer();
    assert($$('#arrangerBody .tray .playing-card').length === 0, `player ${p + 1}: tray is empty once all 7 cards are placed (1+2+4)`);
    assert(slotByZone('one').querySelectorAll('.playing-card').length === 1, `player ${p + 1}: the 1-card slot holds exactly 1 card`);
    assert(slotByZone('two').querySelectorAll('.playing-card').length === 2, `player ${p + 1}: the 2-card slot holds exactly 2 cards`);
    assert(slotByZone('four').querySelectorAll('.playing-card').length === 4, `player ${p + 1}: the 4-card PLO slot holds exactly 4 cards`);
    assert($$('.player-tab')[p].classList.contains('valid'), `player ${p + 1}'s tab is marked valid once their split is complete and legal`);
    if (p < 2) click($$('.player-tab')[p + 1]);
  }

  assert(!$('#btnSweat').disabled, '"Sweat It Out" becomes enabled once every player has a valid, complete split');

  // placed-card click removes it from its slot back to the tray (test on whichever player
  // tab is active, player 3).
  const placedCard = $('#arrangerBody .slot[data-slot="one"] .playing-card');
  assert(!!placedCard, 'a placed card element exists in the "one" slot to test removal');
  click(placedCard);
  assert($$('#arrangerBody .tray .playing-card').length === 1, 'clicking a placed card removes it from its slot and returns exactly one card to the tray');
  assert(slotByZone('one').querySelectorAll('.playing-card').length === 0, 'the "one" slot is empty again after removing its card');
  assert($$('.player-tab')[2].classList.contains('valid') === false, 'removing a placed card makes that player invalid again (incomplete split)');
  assert($('#btnSweat').disabled, '"Sweat It Out" is disabled again while any player is incomplete');
  // put it back (select the lone tray card, click the "one" slot again)
  click($$('#arrangerBody .tray .playing-card')[0]);
  click(slotByZone('one'));
  assert($('#btnSweat').disabled === false, 're-placing the card makes the player valid and re-enables "Sweat It Out" again');

  // ---- sort control exists in the arranger and switches modes ----
  const sortBtns = $$('#arrangerBody .sort-btn');
  assert(sortBtns.length === 3, 'the arranger shows 3 sort-mode buttons (Dealt / Rank / Suit)');
  const rankBtn = sortBtns.find((b) => b.textContent === 'Rank');
  assert(!!rankBtn, 'a "Rank" sort button is present');

  // ---- enter the sweat screen — everything from here on paces itself automatically ----
  click($('#btnSweat'));
  await waitUntil(() => !$('#sweatScreen').classList.contains('hidden'));
  assert($('#setupScreen').classList.contains('hidden'), 'entering the sweat screen hides the setup screen');
  assert(!$('#sweatScreen').classList.contains('hidden'), 'entering the sweat screen un-hides the sweat screen');
  assert($$('#boardACards .card-back').length === 5 && $$('#boardBCards .card-back').length === 5,
    'both boards start fully face-down (5 backs each) before any reveal');
  await waitUntil(() => $$('.compare-player-head').length === 3);
  assert($$('.compare-player-head').length === 3, 'the side-by-side compare table shows one column per player (3 players)');
  assert($$('.compare-row').length === 6, 'the compare table shows 6 rows (3 categories x 2 boards)');
  assert($$('.compare-cell').length === 18, 'the compare table shows one cell per player per row (3 players x 6 rows = 18)');
  assert($$('.compare-cell.cell-pos, .compare-cell.cell-neg, .compare-cell.cell-even').length === 0,
    'before any board cards are known, no compare cell has a decided point class yet');
  assert($$('.cc-cat-name.pending').length > 0, 'before any cards are revealed, pending category cells say "pending…"');
  assert($('#revealControls').textContent.includes('Dealing both flops'),
    'the reveal area shows a passive "Dealing both flops…" status — nothing to click');
  assert(!$('#revealControls button'), 'there is no reveal button anywhere — the flop is not clicked, it just happens');

  // ---- stage 1: flops happen on their own ----
  await waitUntil(() => $$('#boardACards .playing-card').length === 3 && $$('#boardBCards .playing-card').length === 3);
  assert($$('#boardACards .playing-card').length === 3 && $$('#boardBCards .playing-card').length === 3,
    'both flops reveal automatically — exactly 3 cards on EACH board, with no click');
  // the 2-card and 4-card categories are evaluable at the flop; the 1-card category is not yet
  await waitUntil(() => $$('.cc-cat-name.pending').length > 0 && $$('.cc-cat-name').length > $$('.cc-cat-name.pending').length);
  const pendingAtFlop = $$('.cc-cat-name.pending').length;
  assert(pendingAtFlop > 0, 'at the flop, the 1-card hand category is still pending ("pending…") for every player/board cell');
  assert($$('.cc-cat-name').length - pendingAtFlop > 0, 'at the flop, the 2-card and 4-card PLO categories are already showing a resolved category name');

  // ---- the headline feature: a live win% badge even on a PENDING cell (the 1-card hand,
  // which can't be named as a hand yet at the flop, but still has a meaningful win%) ----
  await waitUntil(() => /^\d+%$/.test((doc.getElementById('pctBadge-p0-one-0') || {}).textContent || ''));
  assert(/^\d+%$/.test(doc.getElementById('pctBadge-p0-one-0').textContent),
    'the 1-card hand on Board A shows a live win% badge at the flop, even though the category itself is still pending');
  assert(/^\d+%$/.test(doc.getElementById('pctBadge-p0-two-0').textContent),
    'an already-resolved category (2-card hand) also shows a win% badge, for consistency');

  // ---- stage 2 & 3: turns happen on their own ----
  await waitUntil(() => $$('#boardACards .playing-card').length === 4);
  assert($$('#boardACards .playing-card').length === 4, 'turn A reveals automatically, bringing board A up to 4 known cards');
  await waitUntil(() => $$('#boardBCards .playing-card').length === 4);
  assert($$('#boardBCards .playing-card').length === 4, 'turn B reveals automatically, bringing board B up to 4 known cards');
  // once both boards reach the turn (4 known cards each), the 1-card category becomes evaluable everywhere
  await waitUntil(() => $$('.cc-cat-name.pending').length === 0);
  assert($$('.cc-cat-name.pending').length === 0, 'once both boards reach the turn, no category cell is pending any more (the 1-card hand is now evaluable too)');

  // ---- stage 4: river A — either auto-completes (no swing) or needs a squeeze (swing) ----
  await waitUntil(() => $$('#boardACards .playing-card').length === 5 || !!$('.squeeze-trigger'));
  const triggerA = $('.squeeze-trigger');
  if (triggerA) {
    console.log('river A control type: squeeze (swing detected)');
    assert(!$('#outsPanel').classList.contains('hidden'), 'when a swing is detected on river A, the outs panel is visible');
    assert($$('#outsPanel .out-chip').length > 0, 'the outs panel lists at least one out chip when a swing is detected');
    await squeezeFully(triggerA, 1);
    await waitUntil(() => $$('#boardACards .playing-card').length === 5);
    assert($$('#boardACards .playing-card').length === 5, 'completing the squeeze on river A reveals the 5th board-A card in the board display');
    assert($('#outsPanel').classList.contains('hidden'), 'the outs panel hides again once the swingy river is fully revealed');
  } else {
    console.log('river A control type: automatic (no swing detected)');
    assert($('#outsPanel').classList.contains('hidden'), 'when no swing is detected on river A, the outs panel stays hidden');
    assert($$('#boardACards .playing-card').length === 5, 'river A revealed itself automatically with no swing and nothing to click');
  }

  // ---- stage 5: river B ----
  await waitUntil(() => $$('#boardBCards .playing-card').length === 5 || !!$('.squeeze-trigger'));
  const triggerB = $('.squeeze-trigger');
  if (triggerB) {
    console.log('river B control type: squeeze (swing detected)');
    // first: drag only partway and release early — must snap back, not complete
    click(triggerB);
    await waitUntil(() => !!$('.squeeze-card'));
    const cardOuterEarly = $('.squeeze-card');
    cardOuterEarly.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 0 }));
    w.dispatchEvent(new w.PointerEvent('pointermove', { clientX: 40 })); // well under the 150° lock angle
    w.dispatchEvent(new w.PointerEvent('pointerup', { clientX: 40 }));
    await sleep(60);
    assert(!!$('.squeeze-overlay'), 'releasing the drag early (before the lock angle) does NOT complete the squeeze — the modal stays open');
    assert($$('#boardBCards .playing-card').length === 4, 'an early release leaves board B still at 4 known cards (river not actually revealed)');
    // now drag all the way through to completion
    const cardOuterFull = $('.squeeze-card');
    cardOuterFull.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: 0 }));
    w.dispatchEvent(new w.PointerEvent('pointermove', { clientX: 300 }));
    await waitUntil(() => !$('.squeeze-overlay'), { timeout: 2000 });
    await waitUntil(() => $$('#boardBCards .playing-card').length === 5);
    assert($$('#boardBCards .playing-card').length === 5, 'dragging the squeeze all the way through reveals the 5th board-B card');
  } else {
    console.log('river B control type: automatic (no swing detected)');
    assert($$('#boardBCards .playing-card').length === 5, 'river B revealed itself automatically with no swing and nothing to click');
  }

  // ---- showdown: full multiway scoreboard + comparison log ----
  await waitUntil(() => $('#revealControls').textContent.includes('Showdown complete'));
  assert($('#revealControls').textContent.includes('Showdown complete'), 'after both rivers are revealed, the controls area announces the showdown is complete');
  await waitUntil(() => !$('#showdownExtras').classList.contains('hidden'));
  assert(!$('#showdownExtras').classList.contains('hidden'), 'the showdown extras panel (scoreboard + comparison log) appears once both rivers are fully revealed');
  assert($$('#scoreboard tr').length === 4, 'the scoreboard table has a header row plus one row per player (3 players + header = 4 rows)');
  assert($$('#comparisonLog > div').length === 18, 'the comparison log lists every comparison: 3 players choose 2 = 3 pairings x 3 categories x 2 boards = 18 lines');
  assert($$('.cc-cat-name.pending').length === 0, 'no category cell is pending any more once the showdown is complete');
  const totalPoints = $$('.compare-player-head .pscore').reduce((sum, el) => sum + parseInt(el.textContent, 10), 0);
  assert(totalPoints === 0, `the 3 players' final point totals are zero-sum (sum to 0), got ${totalPoints}`);
  assert(consoleErrors.length === 0, `no uncaught errors occurred at any point during the full setup->sweat->showdown flow, got: ${consoleErrors.join(' | ')}`);

  // ---- New Hand resets back to setup ----
  click($('#btnNewHand'));
  assert($('#sweatScreen').classList.contains('hidden') && !$('#setupScreen').classList.contains('hidden'),
    '"New Hand" returns to the setup screen');
  assert(!$('#preDealPanel').classList.contains('hidden'), '"New Hand" shows the pre-deal panel again, ready for a fresh deal');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);

  // Clicks a squeeze trigger, waits for the modal, then drags it all the way through to
  // completion in one go (used where the test doesn't care about the snap-back path).
  async function squeezeFully(trigger, pointerId) {
    click(trigger);
    await waitUntil(() => !!$('.squeeze-card'));
    const cardOuter = $('.squeeze-card');
    cardOuter.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId, clientX: 0 }));
    w.dispatchEvent(new w.PointerEvent('pointermove', { clientX: 300 }));
    await waitUntil(() => !$('.squeeze-overlay'), { timeout: 2000 });
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
