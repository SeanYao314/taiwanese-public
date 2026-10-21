// tests/ui_sim.test.js — headless DOM simulation of public/client.js using jsdom.
// Playwright's browser tool is network-blocked in this environment (every real
// navigation, even to localhost or example.com, fails with ERR_BLOCKED_BY_CLIENT),
// so this harness drives the ACTUAL client.js/index.html/style.css against a real
// (if headless) DOM and event loop instead of hand-reading the code for bugs.
//
// This covers the rewritten UI: click-a-tray-card-then-click-a-slot arranging
// (matching the reference Taiwanese Poker project), and the multiway-friendly
// per-player/per-category/per-board results display driven by computeLiveSnapshot.
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

  // ---- enter the sweat screen ----
  click($('#btnSweat'));
  await waitUntil(() => !$('#sweatScreen').classList.contains('hidden'));
  assert($('#setupScreen').classList.contains('hidden'), 'entering the sweat screen hides the setup screen');
  assert(!$('#sweatScreen').classList.contains('hidden'), 'entering the sweat screen un-hides the sweat screen');
  assert($$('#boardACards .card-back').length === 5 && $$('#boardBCards .card-back').length === 5,
    'both boards start fully face-down (5 backs each) before any reveal');
  await waitUntil(() => $$('.player-result').length === 3);
  assert($$('.player-result').length === 3, 'the multiway results panel shows one .player-result box per player (3 players)');
  assert($$('.player-result .cat-row').length === 9, 'each of the 3 player boxes shows 3 category rows (3 players x 3 categories = 9)');
  assert($$('.player-result .board-eval.cell-pos, .player-result .board-eval.cell-neg, .player-result .board-eval.cell-even').length === 0,
    'before any board cards are known, no board-eval cell has a decided point class yet');
  assert($$('.player-result .cat-name.pending').length > 0, 'before any cards are revealed, pending category cells say "needs more board cards…"');

  // ---- stage 1: flops ----
  // Each reveal control's click handler awaits the async equity recompute BEFORE advancing
  // sweat.stageIndex and re-rendering the controls, so the control area can lag behind the
  // board cards updating. Wait by reference ("the old control element is gone") rather than
  // re-querying immediately, same pattern used below for the river stages.
  let revealBtn = $('#revealControls button');
  assert(!!revealBtn && revealBtn.textContent.includes('Reveal Both Flops'), 'the first reveal control is "Reveal Both Flops"');
  const flopsBtnNode = revealBtn;
  click(revealBtn);
  await waitUntil(() => $$('#boardACards .playing-card').length === 3 && $$('#boardBCards .playing-card').length === 3);
  assert($$('#boardACards .playing-card').length === 3 && $$('#boardBCards .playing-card').length === 3,
    'clicking "Reveal Both Flops" reveals exactly 3 cards on EACH board simultaneously');
  // the 2-card and 4-card categories are evaluable at the flop; the 1-card category is not yet
  await waitUntil(() => $$('.player-result .cat-name.pending').length > 0 && $$('.player-result .cat-name').length > $$('.player-result .cat-name.pending').length);
  const pendingAtFlop = $$('.player-result .cat-name.pending').length;
  assert(pendingAtFlop > 0, 'at the flop, the 1-card hand category is still pending ("needs more board cards…") for every player/board cell');
  assert($$('.player-result .cat-name').length - pendingAtFlop > 0, 'at the flop, the 2-card and 4-card PLO categories are already showing a resolved category name');

  // ---- stage 2 & 3: turns ----
  await waitUntil(() => !doc.contains(flopsBtnNode) && !!$('#revealControls .reveal-card-btn'));
  revealBtn = $('#revealControls .reveal-card-btn');
  assert(revealBtn.className.includes('reveal-card-btn'), 'after the flops, the next control is a plain reveal button (turn A)');
  const turnABtnNode = revealBtn;
  click(revealBtn);
  await waitUntil(() => $$('#boardACards .playing-card').length === 4);
  assert($$('#boardACards .playing-card').length === 4, 'turn A reveal brings board A up to 4 known cards');

  await waitUntil(() => !doc.contains(turnABtnNode) && !!$('#revealControls .reveal-card-btn'));
  revealBtn = $('#revealControls .reveal-card-btn');
  const turnBBtnNode = revealBtn;
  click(revealBtn);
  await waitUntil(() => $$('#boardBCards .playing-card').length === 4);
  assert($$('#boardBCards .playing-card').length === 4, 'turn B reveal brings board B up to 4 known cards');
  // once both boards reach the turn (4 known cards each), the 1-card category becomes evaluable everywhere
  await waitUntil(() => $$('.player-result .cat-name.pending').length === 0);
  assert($$('.player-result .cat-name.pending').length === 0, 'once both boards reach the turn, no category cell is pending any more (the 1-card hand is now evaluable too)');

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
    assert($$('#outsPanel .out-chip').length > 0, 'the outs panel lists at least one out chip when a swing is detected');
    // simulate a full hold-to-peel: pointerdown, wait past the reveal duration, then release
    peel.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    await waitUntil(() => peel.classList.contains('locked'), { timeout: 4000 });
    assert(peel.classList.contains('locked'), 'holding the peel card past its full duration locks it revealed');
    await waitUntil(() => $$('#boardACards .playing-card').length === 5);
    assert($$('#boardACards .playing-card').length === 5, 'completing the peel on river A reveals the 5th board-A card in the board display');
    assert($('#outsPanel').classList.contains('hidden'), 'the outs panel hides again once the swingy river is fully revealed');
  } else {
    // snap-back check: press and release early, card must NOT reveal
    const btn = $('#revealControls .reveal-card-btn');
    riverAControlNode = btn;
    assert($('#outsPanel').classList.contains('hidden'), 'when no swing is detected on river A, the outs panel stays hidden');
    click(btn);
    await waitUntil(() => $$('#boardACards .playing-card').length === 5);
    assert($$('#boardACards .playing-card').length === 5, 'clicking the plain reveal button reveals the 5th board-A card');
  }

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
    assert($$('#boardBCards .playing-card').length === 4, 'an early release leaves board B still at 4 known cards (river not actually revealed)');
    // now hold it fully through to completion
    peelB.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, pointerId: 3 }));
    await waitUntil(() => peelB.classList.contains('locked'), { timeout: 4000 });
    assert(peelB.classList.contains('locked'), 'holding the peel card fully through now locks it revealed');
    await waitUntil(() => $$('#boardBCards .playing-card').length === 5);
    assert($$('#boardBCards .playing-card').length === 5, 'completing the peel on river B reveals the 5th board-B card');
  } else {
    const btnB = $('#revealControls .reveal-card-btn');
    click(btnB);
    await waitUntil(() => $$('#boardBCards .playing-card').length === 5);
    assert($$('#boardBCards .playing-card').length === 5, 'clicking the plain reveal button reveals the 5th board-B card');
  }

  // ---- showdown: full multiway scoreboard + comparison log ----
  await waitUntil(() => $('#revealControls').textContent.includes('Showdown complete'));
  assert($('#revealControls').textContent.includes('Showdown complete'), 'after both rivers are revealed, the controls area announces the showdown is complete');
  await waitUntil(() => !$('#showdownExtras').classList.contains('hidden'));
  assert(!$('#showdownExtras').classList.contains('hidden'), 'the showdown extras panel (scoreboard + comparison log) appears once both rivers are fully revealed');
  assert($$('#scoreboard tr').length === 4, 'the scoreboard table has a header row plus one row per player (3 players + header = 4 rows)');
  assert($$('#comparisonLog > div').length === 18, 'the comparison log lists every comparison: 3 players choose 2 = 3 pairings x 3 categories x 2 boards = 18 lines');
  assert($$('.player-result .cat-name.pending').length === 0, 'no category cell is pending any more once the showdown is complete');
  const totalPoints = $$('.player-result .pscore').reduce((sum, el) => sum + parseInt(el.textContent, 10), 0);
  assert(totalPoints === 0, `the 3 players' final point totals are zero-sum (sum to 0), got ${totalPoints}`);
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
