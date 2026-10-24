// public/client.js — Sweat Room UI: hand setup/arranging (same click-a-card-then-click-a-box
// model as the Taiwanese Poker project), then the automatically-paced flop->turn->river sweat
// with a live, side-by-side win%/scoreboard table (per player, per category, per board) and a
// baccarat/ClubGG-style drag-to-squeeze reveal for swingy rivers.
// Depends on window.Poker, window.Game, window.Equity (loaded as plain <script> tags).
'use strict';

(function () {
  const P = window.Poker;
  const G = window.Game;
  const E = window.Equity;

  // ---------------------------------------------------------------------
  // Card rendering + sorting (same conventions as the Taiwanese Poker project)
  // ---------------------------------------------------------------------
  const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SUIT_CLASS = { s: 'suit-s', h: 'suit-h', d: 'suit-d', c: 'suit-c' }; // 4-color deck
  const CAPACITY = { one: 1, two: 2, four: 4 };
  const SLOT_TITLES = { one: '1-Card Hand', two: '2-Card Hand', four: '4-Card PLO Hand' };
  const ZONES = ['one', 'two', 'four'];

  const CARD_SORT_KEY = 'sweat-room-card-sort';
  const RANK_ORDER = '23456789TJQKA';
  const SUIT_ORDER = ['s', 'h', 'd', 'c'];
  let cardSortMode = 'dealt';
  try {
    const saved = localStorage.getItem(CARD_SORT_KEY);
    if (saved === 'rank' || saved === 'suit' || saved === 'dealt') cardSortMode = saved;
  } catch (e) { /* localStorage unavailable — default stays 'dealt' */ }

  function sortCards(cards, mode) {
    if (mode !== 'rank' && mode !== 'suit') return cards;
    const arr = cards.slice();
    const rankOf = (c) => RANK_ORDER.indexOf(c[0]);
    const suitOf = (c) => SUIT_ORDER.indexOf(c[1]);
    if (mode === 'rank') arr.sort((a, b) => rankOf(b) - rankOf(a) || suitOf(a) - suitOf(b));
    else arr.sort((a, b) => suitOf(a) - suitOf(b) || rankOf(b) - rankOf(a));
    return arr;
  }

  function cardEl(card, { size = 'normal', usedInBest = false, static: isStatic = false } = {}) {
    const rank = card[0];
    const suit = card[1];
    const div = document.createElement('div');
    div.className = 'playing-card'
      + (size === 'small' ? ' small' : '')
      + (isStatic ? ' static' : '')
      + ' ' + SUIT_CLASS[suit]
      + (usedInBest ? ' used-in-best' : '');
    div.dataset.card = card;
    div.innerHTML = `<span class="rank">${rank}</span><span class="suit">${SUIT_SYMBOL[suit]}</span>`;
    return div;
  }

  function cardRow(cards, opts) {
    const wrap = document.createElement('span');
    wrap.style.display = 'inline-flex';
    wrap.style.gap = '4px';
    wrap.style.flexWrap = 'wrap';
    cards.forEach((c) => wrap.appendChild(cardEl(c, opts)));
    return wrap;
  }

  function cardBackEl() {
    const div = document.createElement('div');
    div.className = 'card-back';
    return div;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtSigned(n) { return (n > 0 ? '+' : '') + n; }

  // ---------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const show = (id) => el(id).classList.remove('hidden');
  const hide = (id) => el(id).classList.add('hidden');

  // ---------------------------------------------------------------------
  // Setup state
  // ---------------------------------------------------------------------
  const setup = {
    playerCount: 2,
    names: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
    homerunMode: false,
    dealt: null,          // { hands: {id:[7 cards]}, boards: [boardA, boardB] }
    ids: [],              // ['p0','p1',...]
    assignments: {},      // id -> { one:[], two:[], four:[] }
    activePlayerIdx: 0,
    selectedCard: null
  };

  function renderPlayerCountGroup() {
    el('playerCountGroup').querySelectorAll('.pill-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.count) === setup.playerCount);
    });
  }

  function renderNameInputs() {
    const wrap = el('playerNameInputs');
    wrap.innerHTML = '';
    for (let i = 0; i < setup.playerCount; i++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = setup.names[i];
      input.placeholder = `Player ${i + 1}`;
      input.addEventListener('input', () => { setup.names[i] = input.value.trim() || `Player ${i + 1}`; });
      wrap.appendChild(input);
    }
  }

  el('playerCountGroup').querySelectorAll('.pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setup.playerCount = Number(btn.dataset.count);
      renderPlayerCountGroup();
      renderNameInputs();
    });
  });
  // default to 2 players active on load
  el('playerCountGroup').querySelector('.pill-btn[data-count="2"]').classList.add('active');
  renderNameInputs();
  el('homerunToggle').addEventListener('change', () => { setup.homerunMode = el('homerunToggle').checked; });

  function dealNewHand() {
    setup.ids = [];
    for (let i = 0; i < setup.playerCount; i++) setup.ids.push('p' + i);
    setup.dealt = G.dealHand(setup.ids, 7);
    setup.assignments = {};
    setup.ids.forEach((id) => { setup.assignments[id] = { one: [], two: [], four: [] }; });
    setup.activePlayerIdx = 0;
    setup.selectedCard = null;

    hide('preDealPanel');
    show('arrangePanel');
    renderPlayerTabs();
    renderArranger();
  }

  el('btnDeal').addEventListener('click', dealNewHand);
  el('btnRedeal').addEventListener('click', () => {
    hide('arrangePanel');
    show('preDealPanel');
    setup.dealt = null;
  });

  // ---------------------------------------------------------------------
  // Arranger — click a tray card to select it, then click a hand box to place it there
  // (or remove a placed card by clicking it). Cmd/Ctrl+click a tray card to drop it
  // straight into the first open slot. Same interaction model as the live game.
  // ---------------------------------------------------------------------
  function playerIsValid(id) {
    return G.validateAssignment(setup.dealt.hands[id], setup.assignments[id]) === null;
  }
  function allPlayersValid() {
    return setup.ids.length > 0 && setup.ids.every(playerIsValid);
  }

  function renderPlayerTabs() {
    const wrap = el('playerTabs');
    wrap.innerHTML = '';
    setup.ids.forEach((id, idx) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'player-tab' + (idx === setup.activePlayerIdx ? ' active' : '') + (playerIsValid(id) ? ' valid' : '');
      tab.innerHTML = `${escapeHtml(setup.names[idx])} <span class="check">✓</span>`;
      tab.addEventListener('click', () => {
        setup.activePlayerIdx = idx;
        setup.selectedCard = null;
        renderPlayerTabs();
        renderArranger();
      });
      wrap.appendChild(tab);
    });
  }

  function placeInFirstOpenSlot(assignment, card, capacity) {
    for (const slot of ZONES) {
      if (assignment[slot].length < capacity[slot]) {
        assignment[slot].push(card);
        return true;
      }
    }
    return false;
  }

  function trayCards(id) {
    const hand = setup.dealt.hands[id];
    const asg = setup.assignments[id];
    const used = new Set([...asg.one, ...asg.two, ...asg.four]);
    return sortCards(hand.filter((c) => !used.has(c)), cardSortMode);
  }

  function renderArranger() {
    const id = setup.ids[setup.activePlayerIdx];
    const asg = setup.assignments[id];

    const wrap = document.createElement('div');

    const slots = document.createElement('div');
    slots.className = 'slots';
    ZONES.forEach((zone) => {
      const slotDiv = document.createElement('div');
      slotDiv.className = 'slot';
      slotDiv.dataset.slot = zone;

      const title = document.createElement('div');
      title.className = 'slot-title';
      title.innerHTML = `${SLOT_TITLES[zone]} <span class="pt">worth ${G.POINTS[zone]} pt / board</span>`;
      slotDiv.appendChild(title);

      const cardsDiv = document.createElement('div');
      cardsDiv.className = 'slot-cards';
      asg[zone].forEach((c) => {
        const node = cardEl(c);
        node.addEventListener('click', (ev) => {
          ev.stopPropagation();
          asg[zone] = asg[zone].filter((x) => x !== c);
          setup.selectedCard = null;
          renderPlayerTabs();
          renderArranger();
        });
        cardsDiv.appendChild(node);
      });
      slotDiv.appendChild(cardsDiv);

      slotDiv.addEventListener('click', () => {
        if (!setup.selectedCard) return;
        if (asg[zone].length >= CAPACITY[zone]) return;
        asg[zone].push(setup.selectedCard);
        setup.selectedCard = null;
        renderPlayerTabs();
        renderArranger();
      });

      slots.appendChild(slotDiv);
    });
    wrap.appendChild(slots);

    const trayWrap = document.createElement('div');
    trayWrap.className = 'tray-wrap';

    const trayTitleRow = document.createElement('div');
    trayTitleRow.className = 'slot-title tray-title-row';
    const trayLabel = document.createElement('span');
    trayLabel.innerHTML = `Your Cards <span class="hint-inline">(click a card, then click a hand above &mdash; or &#8984;/Ctrl+click a card to drop it in the first open slot)</span>`;
    trayTitleRow.appendChild(trayLabel);

    const sortControl = document.createElement('span');
    sortControl.className = 'sort-control';
    const sortLabel = document.createElement('span');
    sortLabel.className = 'sort-label';
    sortLabel.textContent = 'Sort:';
    sortControl.appendChild(sortLabel);
    ['dealt', 'rank', 'suit'].forEach((mode) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sort-btn' + (cardSortMode === mode ? ' active' : '');
      btn.textContent = mode[0].toUpperCase() + mode.slice(1);
      btn.addEventListener('click', () => {
        if (cardSortMode === mode) return;
        cardSortMode = mode;
        try { localStorage.setItem(CARD_SORT_KEY, cardSortMode); } catch (e) { /* ignore */ }
        renderArranger();
      });
      sortControl.appendChild(btn);
    });
    trayTitleRow.appendChild(sortControl);
    trayWrap.appendChild(trayTitleRow);

    const tray = document.createElement('div');
    tray.className = 'tray';
    trayCards(id).forEach((c) => {
      const node = cardEl(c);
      if (setup.selectedCard === c) node.classList.add('selected');
      node.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey) {
          placeInFirstOpenSlot(asg, c, CAPACITY);
          setup.selectedCard = null;
          renderPlayerTabs();
          renderArranger();
          return;
        }
        setup.selectedCard = setup.selectedCard === c ? null : c;
        renderArranger();
      });
      tray.appendChild(node);
    });
    trayWrap.appendChild(tray);
    wrap.appendChild(trayWrap);

    el('arrangerBody').innerHTML = '';
    el('arrangerBody').appendChild(wrap);

    updateSweatButton();
  }

  function updateSweatButton() {
    el('btnSweat').disabled = !allPlayersValid();
  }

  el('btnSweat').addEventListener('click', () => {
    if (!allPlayersValid()) return;
    startSweat();
  });

  // ---------------------------------------------------------------------
  // Sweat state
  // ---------------------------------------------------------------------
  const REVEAL_STAGES = [
    { id: 'flops' },
    { id: 'turnA', board: 0 },
    { id: 'turnB', board: 1 },
    { id: 'riverA', board: 0 },
    { id: 'riverB', board: 1 },
    { id: 'done' }
  ];

  const STAGE_PASSIVE_LABEL = {
    flops: 'Dealing both flops…',
    turnA: 'Dealing the turn — Board A…',
    turnB: 'Dealing the turn — Board B…'
  };

  // The reveal paces itself now — nobody clicks through flop/turn/river. In Solo, this
  // browser's own setTimeout chain drives it (soloAutoTick below); in Multiplayer, the
  // server drives it for everyone (lib/rooms.js) and this client just mirrors whatever it
  // polls. Both sides use the same hold time, so the feel matches whichever mode you're in.
  // Tests can speed the solo timers up the same way the server's tests do, via
  // window.__SWEAT_ROOM_FAST_TIMERS__.
  const CLIENT_FAST = typeof window !== 'undefined' && !!window.__SWEAT_ROOM_FAST_TIMERS__;
  const AUTO_INITIAL_MS = CLIENT_FAST ? 15 : 1000;
  const AUTO_HOLD_MS = CLIENT_FAST ? 15 : 2500;

  const sweat = {
    mode: 'solo',      // 'solo' (this browser arranged every seat) or 'mp' (server-driven room)
    mpCode: null,
    mpIsHost: false,
    mpHostId: null,
    pendingSwing: null, // the river outs check — server-computed in mp (mirrored to every
                         // viewer), locally computed in solo. { boardIndex, hasSwing, swingThreshold, outs }
    players: [],      // [{id, name, assignment}]
    boardA: [],
    boardB: [],
    revealedA: 0,
    revealedB: 0,
    stageIndex: 0,
    homerunMode: false
  };

  // Guards the solo auto-advance timer chain against a stale tick firing after the hand's
  // moved on (a new hand started, or we left the sweat screen) — every scheduled tick checks
  // its own generation number against the current one before doing anything.
  let soloAutoTimer = null;
  let soloAutoGen = 0;

  function clearSoloAutoTimer() {
    if (soloAutoTimer) { clearTimeout(soloAutoTimer); soloAutoTimer = null; }
  }
  function scheduleSoloAuto(delayMs, fn) {
    clearSoloAutoTimer();
    const gen = soloAutoGen;
    soloAutoTimer = setTimeout(() => {
      soloAutoTimer = null;
      if (gen !== soloAutoGen) return; // the hand moved on while we were waiting — no-op
      fn();
    }, delayMs);
  }

  function startSweat() {
    sweat.mode = 'solo';
    sweat.pendingSwing = null;
    sweat.players = setup.ids.map((id, idx) => ({
      id, name: setup.names[idx], assignment: setup.assignments[id]
    }));
    sweat.boardA = setup.dealt.boards[0];
    sweat.boardB = setup.dealt.boards[1];
    sweat.revealedA = 0;
    sweat.revealedB = 0;
    sweat.stageIndex = 0;
    sweat.homerunMode = setup.homerunMode;
    soloAutoGen += 1;

    hide('setupScreen');
    show('sweatScreen');
    el('outsPanel').classList.add('hidden');
    el('homerunBanner').classList.add('hidden');
    el('showdownExtras').classList.add('hidden');
    renderBoards();
    renderStage();
    recomputeStanding();
    scheduleSoloAuto(AUTO_INITIAL_MS, soloAutoTick);
  }

  el('btnNewHand').addEventListener('click', async () => {
    if (sweat.mode === 'mp') {
      if (sweat.mpIsHost) {
        el('btnNewHand').disabled = true;
        const resp = await mpApi('POST', `/api/rooms/${mp.code}/new-hand`, { playerId: mp.playerId });
        el('btnNewHand').disabled = false;
        if (resp.error) { alert(resp.error); return; }
        handleMpRoomUpdate(resp.room);
      }
      // non-host players just wait — the next poll tick will see phase go back to 'lobby'
      // and handleMpRoomUpdate will bring everyone back to the room screen automatically.
      return;
    }
    soloAutoGen += 1; // invalidate any pending auto-tick from this hand
    clearSoloAutoTimer();
    hide('sweatScreen');
    show('setupScreen');
    show('preDealPanel');
    hide('arrangePanel');
    setup.dealt = null;
  });

  // Only the host can actually start a new hand — hide the control for everyone else once
  // we know we're in a multiplayer room (toggled from applyRoomToSweat/renderStageMp).
  function syncNewHandButtonVisibility() {
    const btn = el('btnNewHand');
    if (sweat.mode === 'mp' && !sweat.mpIsHost) btn.classList.add('hidden');
    else btn.classList.remove('hidden');
  }

  // Always renders exactly 5 slots per board, using only indices < revealedCount for the
  // face-up cards. This works whether `sweat.boardA/B` holds the FULL 5-card board (solo —
  // we already know every card locally, revealedA/B is just a display cursor) or only the
  // cards actually revealed so far (multiplayer — the server never sends an unrevealed
  // board card over the wire at all, for real privacy, so the array itself is only as long
  // as revealedA/B) — either way we only ever read index < revealedA/B.
  function renderBoards() {
    const boardACards = el('boardACards');
    const boardBCards = el('boardBCards');
    boardACards.innerHTML = '';
    boardBCards.innerHTML = '';
    for (let i = 0; i < 5; i++) boardACards.appendChild(i < sweat.revealedA ? cardEl(sweat.boardA[i]) : cardBackEl());
    for (let i = 0; i < 5; i++) boardBCards.appendChild(i < sweat.revealedB ? cardEl(sweat.boardB[i]) : cardBackEl());
  }

  // ---------------------------------------------------------------------
  // Live standing (deterministic, "where do things stand right now") + equity
  // (probabilistic win%/projected points, looking ahead at what's still unseen)
  // ---------------------------------------------------------------------
  function categoryLabelKey(boardIndex, cat) {
    return (boardIndex === 0 ? 'A.' : 'B.') + cat;
  }

  async function recomputeStanding() {
    const boardAKnown = sweat.boardA.slice(0, sweat.revealedA);
    const boardBKnown = sweat.boardB.slice(0, sweat.revealedB);
    const snapshot = G.computeLiveSnapshot(sweat.players, [boardAKnown, boardBKnown], sweat.homerunMode);
    renderCompareTable(snapshot);
    updateCompareTablePercents(null);

    const loadingNotes = {};
    sweat.players.forEach((p) => { loadingNotes[p.id] = 'working out the odds…'; });
    renderEquityNotes(loadingNotes);

    const equity = await E.computeStageEquity({
      players: sweat.players,
      boardAKnown,
      boardBKnown,
      homerunMode: sweat.homerunMode,
      onProgress: (frac) => {
        const notes = {};
        sweat.players.forEach((p) => { notes[p.id] = `working out the odds… ${Math.round(frac * 100)}%`; });
        renderEquityNotes(notes);
      }
    });
    renderEquityNotes(null, equity);
    updateCompareTablePercents(equity);

    if (REVEAL_STAGES[sweat.stageIndex].id === 'done') renderShowdownExtras(snapshot);
  }

  function cellPointTotals(snapshot) {
    // cellPoints[playerId][category][boardIndex] — a player's point swing in that one
    // cell, summed across every opponent at the table (so this generalizes correctly to
    // 3-4 players, not just heads-up).
    const totals = {};
    sweat.players.forEach((p) => {
      totals[p.id] = { one: [0, 0], two: [0, 0], four: [0, 0] };
    });
    snapshot.comparisons.forEach((c) => {
      if (!c.winner) return;
      const loser = c.winner === c.playerA ? c.playerB : c.playerA;
      totals[c.winner][c.category][c.boardIndex] += c.points;
      totals[loser][c.category][c.boardIndex] -= c.points;
    });
    return totals;
  }

  // ---------------------------------------------------------------------
  // Side-by-side compare table — one column per player, one row per category×board, with
  // a live win% badge in every cell (even "pending" ones that can't be named as a hand yet,
  // e.g. the 1-card hand before the turn — categoryWinPct is still meaningful there, it's
  // just a probability instead of a certainty).
  // ---------------------------------------------------------------------
  function renderCompareTable(snapshot) {
    const cellPoints = cellPointTotals(snapshot);
    const wrap = el('resultsPlayers');
    wrap.innerHTML = '';

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'compare-scroll';
    const table = document.createElement('table');
    table.className = 'compare-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'compare-corner';
    headRow.appendChild(corner);

    sweat.players.forEach((p) => {
      const th = document.createElement('th');
      th.className = 'compare-player-head';

      const nameRow = document.createElement('div');
      nameRow.className = 'cph-name-row';
      const pname = document.createElement('span');
      pname.className = 'pname';
      pname.textContent = p.name;
      nameRow.appendChild(pname);
      const homeruns = snapshot.homeruns.filter((h) => h.winner === p.id);
      if (homeruns.length) {
        const tag = document.createElement('span');
        tag.className = 'homerun-tag';
        tag.textContent = `⚾${homeruns.length > 1 ? ' x' + homeruns.length : ''}`;
        nameRow.appendChild(tag);
      }
      th.appendChild(nameRow);

      const pts = snapshot.pointsByPlayer[p.id];
      const pscore = document.createElement('div');
      pscore.className = 'pscore ' + (pts > 0 ? 'pos' : pts < 0 ? 'neg' : '');
      pscore.textContent = fmtSigned(pts) + ' so far';
      th.appendChild(pscore);

      const note = document.createElement('div');
      note.className = 'cph-note';
      note.id = 'equityNote-' + p.id;
      note.textContent = ' ';
      th.appendChild(note);

      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    ZONES.forEach((cat) => {
      const groupRow = document.createElement('tr');
      groupRow.className = 'compare-group-row';
      const groupTd = document.createElement('td');
      groupTd.colSpan = sweat.players.length + 1;
      groupTd.textContent = SLOT_TITLES[cat];
      groupRow.appendChild(groupTd);
      tbody.appendChild(groupRow);

      [0, 1].forEach((boardIndex) => {
        const row = document.createElement('tr');
        row.className = 'compare-row';
        const labelTd = document.createElement('td');
        labelTd.className = 'compare-row-label';
        labelTd.textContent = boardIndex === 0 ? 'Board A' : 'Board B';
        row.appendChild(labelTd);

        sweat.players.forEach((p) => {
          const evalInfo = snapshot.evals[p.id][cat][boardIndex];
          const td = document.createElement('td');
          td.className = 'compare-cell';

          const handRow = cardRow(p.assignment[cat], { size: 'small', static: true });
          if (evalInfo) {
            const usedSet = new Set(evalInfo.cards);
            [...handRow.children].forEach((child, idx) => {
              if (usedSet.has(p.assignment[cat][idx])) child.classList.add('used-in-best');
            });
          }
          td.appendChild(handRow);

          const catName = document.createElement('div');
          catName.className = 'cc-cat-name' + (evalInfo ? '' : ' pending');
          catName.textContent = evalInfo ? P.categoryName(evalInfo.score) : 'pending…';
          td.appendChild(catName);

          const badgeRow = document.createElement('div');
          badgeRow.className = 'cc-badge-row';

          const pctBadge = document.createElement('span');
          pctBadge.className = 'pct-badge';
          pctBadge.id = `pctBadge-${p.id}-${cat}-${boardIndex}`;
          pctBadge.title = 'Chance of winning this category on this board';
          pctBadge.textContent = '…';
          badgeRow.appendChild(pctBadge);

          if (evalInfo) {
            const current = cellPoints[p.id][cat][boardIndex];
            const ptsBadge = document.createElement('span');
            ptsBadge.className = 'cell-points ' + (current > 0 ? 'pos' : current < 0 ? 'neg' : 'even');
            ptsBadge.textContent = fmtSigned(current);
            badgeRow.appendChild(ptsBadge);
            td.classList.add(current > 0 ? 'cell-pos' : current < 0 ? 'cell-neg' : 'cell-even');
          }
          td.appendChild(badgeRow);

          row.appendChild(td);
        });

        tbody.appendChild(row);
      });
    });
    table.appendChild(tbody);

    scrollWrap.appendChild(table);
    wrap.appendChild(scrollWrap);

    if (snapshot.homeruns.length) {
      const nameById = {};
      sweat.players.forEach((p) => { nameById[p.id] = p.name; });
      const banner = el('homerunBanner');
      banner.innerHTML = '';
      snapshot.homeruns.forEach((h, i) => {
        if (i > 0) banner.appendChild(document.createElement('br'));
        const loserId = h.winner === h.playerA ? h.playerB : h.playerA;
        banner.appendChild(document.createTextNode(
          `⚾ ${nameById[h.winner]} hit a HOMERUN — swept all 6 comparisons (both boards) vs ${nameById[loserId]} (double points!)`
        ));
      });
      banner.classList.remove('hidden');
    } else {
      el('homerunBanner').classList.add('hidden');
    }
  }

  // Fills in (or clears, while still computing) the per-cell win% badges without rebuilding
  // the whole table — equity may be null while the computation is still running.
  function updateCompareTablePercents(equity) {
    sweat.players.forEach((p) => {
      ZONES.forEach((cat) => {
        [0, 1].forEach((boardIndex) => {
          const badge = el(`pctBadge-${p.id}-${cat}-${boardIndex}`);
          if (!badge) return;
          if (!equity) { badge.textContent = '…'; return; }
          const label = categoryLabelKey(boardIndex, cat);
          const pct = equity.categoryWinPct[p.id][label];
          badge.textContent = Math.round(pct * 100) + '%';
        });
      });
    });
  }

  function renderEquityNotes(loadingNotes, equity) {
    sweat.players.forEach((p) => {
      const sub = el('equityNote-' + p.id);
      if (!sub) return;
      if (loadingNotes) {
        sub.textContent = loadingNotes[p.id] || ' ';
        return;
      }
      if (!equity) return;
      if (equity.mode === 'determined') {
        sub.textContent = ' ';
        return;
      }
      const win = (equity.winPct[p.id] * 100).toFixed(1);
      const ep = equity.expectedPoints[p.id];
      sub.textContent = `Projected finish: ${fmtSigned(Math.round(ep * 10) / 10)} pts · ${win}% to lead the table`;
    });
  }

  // ---------------------------------------------------------------------
  // Showdown extras (scoreboard + comparison log) — only shown once both rivers are in.
  // ---------------------------------------------------------------------
  function renderShowdownExtras(snapshot) {
    const nameById = {};
    sweat.players.forEach((p) => { nameById[p.id] = p.name; });

    const sorted = [...sweat.players].sort((a, b) => snapshot.pointsByPlayer[b.id] - snapshot.pointsByPlayer[a.id]);
    const table = el('scoreboard');
    table.innerHTML = '<tr><th>Player</th><th>Points</th></tr>' + sorted.map((p) => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td><strong>${fmtSigned(snapshot.pointsByPlayer[p.id])}</strong></td>
      </tr>
    `).join('');
    table.classList.add('card-reveal');

    const log = el('comparisonLog');
    log.innerHTML = '';
    snapshot.comparisons.forEach((c) => {
      const boardLabel = c.boardIndex === 0 ? 'Board A' : 'Board B';
      const catLabel = SLOT_TITLES[c.category];
      const line = document.createElement('div');
      if (!c.winner) {
        line.className = 'push';
        line.textContent = `${nameById[c.playerA]} vs ${nameById[c.playerB]} — ${catLabel} on ${boardLabel}: push (no points)`;
      } else {
        const loserName = c.winner === c.playerA ? nameById[c.playerB] : nameById[c.playerA];
        line.textContent = `${nameById[c.winner]} beat ${loserName} — ${catLabel} on ${boardLabel}: +${c.points}`;
      }
      log.appendChild(line);
    });

    el('showdownExtras').classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Solo auto-advance driver — mirrors the server's autoTick/autoRiverCheck/completeRiver
  // (lib/rooms.js) so Solo and Multiplayer feel identical: nothing to click for flop/turn/
  // river, except physically completing the squeeze on a river that turns out to be a
  // swing spot.
  // ---------------------------------------------------------------------
  async function soloAutoTick() {
    const stage = REVEAL_STAGES[sweat.stageIndex].id;
    if (stage === 'flops') {
      sweat.revealedA = 3;
      sweat.revealedB = 3;
      sweat.stageIndex += 1;
      renderBoards();
      renderStage();
      await recomputeStanding();
      scheduleSoloAuto(AUTO_HOLD_MS, soloAutoTick);
    } else if (stage === 'turnA') {
      sweat.revealedA = 4;
      sweat.stageIndex += 1;
      renderBoards();
      renderStage();
      await recomputeStanding();
      scheduleSoloAuto(AUTO_HOLD_MS, soloAutoTick);
    } else if (stage === 'turnB') {
      sweat.revealedB = 4;
      sweat.stageIndex += 1;
      renderBoards();
      renderStage();
      await recomputeStanding();
      scheduleSoloAuto(AUTO_HOLD_MS, soloAutoTick);
    } else if (stage === 'riverA' || stage === 'riverB') {
      await soloAutoRiverCheck(stage === 'riverA' ? 0 : 1);
    }
    // 'done' — nothing left to tick.
  }

  async function soloAutoRiverCheck(boardIndex) {
    const gen = soloAutoGen;
    renderStage(); // "Checking the river for outs…"
    const boards = [sweat.boardA.slice(0, sweat.revealedA), sweat.boardB.slice(0, sweat.revealedB)];
    const swing = await E.computeRiverSwing({
      players: sweat.players,
      boards,
      pendingBoardIndex: boardIndex,
      homerunMode: sweat.homerunMode
    });
    if (gen !== soloAutoGen) return; // the hand moved on while we were awaiting the check
    sweat.pendingSwing = {
      boardIndex,
      hasSwing: swing.hasSwing,
      swingThreshold: swing.swingThreshold,
      outs: swing.outs
    };
    renderOutsPanel(sweat.pendingSwing);
    renderStage();
    if (!swing.hasSwing) {
      scheduleSoloAuto(AUTO_HOLD_MS, () => completeRiverAuto(boardIndex));
    }
    // if it IS a swing: stop here — renderStage() is now showing the squeeze trigger, and
    // only the player physically completing that squeeze (see openSqueezeModal) moves on.
  }

  function completeRiverAuto(boardIndex) {
    if (boardIndex === 0) sweat.revealedA = 5; else sweat.revealedB = 5;
    sweat.pendingSwing = null;
    el('outsPanel').classList.add('hidden');
    sweat.stageIndex += 1;
    renderBoards();
    recomputeStanding().then(() => {
      renderStage();
      if (REVEAL_STAGES[sweat.stageIndex].id !== 'done') scheduleSoloAuto(AUTO_HOLD_MS, soloAutoTick);
    });
  }

  // ---------------------------------------------------------------------
  // Reveal status — a passive display everywhere except the squeeze (the one gesture that's
  // still ever physically done by a person).
  // ---------------------------------------------------------------------
  function renderStage() {
    const stage = REVEAL_STAGES[sweat.stageIndex];
    if (sweat.mode === 'mp') { renderStageMp(stage); return; }
    renderStageSolo(stage);
  }

  function renderStageSolo(stage) {
    el('revealControls').innerHTML = '';
    if (stage.id === 'done') {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">🏁 Showdown complete</div></div>`;
      return;
    }
    if (stage.id === 'flops' || stage.id === 'turnA' || stage.id === 'turnB') {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">${STAGE_PASSIVE_LABEL[stage.id]}</div></div>`;
      return;
    }
    // riverA / riverB
    const boardIndex = stage.board;
    if (!sweat.pendingSwing || sweat.pendingSwing.boardIndex !== boardIndex) {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">Checking the river for outs…</div></div>`;
      return;
    }
    if (sweat.pendingSwing.hasSwing) {
      const cardIndex = boardIndex === 0 ? sweat.revealedA : sweat.revealedB;
      const card = (boardIndex === 0 ? sweat.boardA : sweat.boardB)[cardIndex];
      renderSqueezeControl(boardIndex, card, () => completeRiverAuto(boardIndex));
    } else {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">Revealing the river — Board ${boardIndex === 0 ? 'A' : 'B'}…</div></div>`;
    }
  }

  function renderOutsPanel(swing) {
    if (!swing || !swing.hasSwing || swing.outs.length === 0) {
      el('outsPanel').classList.add('hidden');
      el('outsPanel').innerHTML = '';
      return;
    }
    const byBeneficiary = {};
    swing.outs.forEach((out) => { (byBeneficiary[out.beneficiary] = byBeneficiary[out.beneficiary] || []).push(out); });
    let html = `<h4>⚠ This river can swing the hand ${swing.swingThreshold}+ points — here are the outs</h4>`;
    Object.keys(byBeneficiary).forEach((pid) => {
      const player = sweat.players.find((p) => p.id === pid);
      const outs = byBeneficiary[pid].sort((a, b) => b.maxAbsDelta - a.maxAbsDelta);
      html += `<div class="outs-group"><b>${escapeHtml(player ? player.name : pid)}</b> gains up to +${outs[0].maxAbsDelta.toFixed(1)} pts with:
        <span class="outs-cards">${outs.map((o) => outChipHTML(o.card)).join('')}</span></div>`;
    });
    el('outsPanel').innerHTML = html;
    el('outsPanel').classList.remove('hidden');
  }

  function outChipHTML(card) {
    const suit = card[1];
    return `<span class="out-chip ${SUIT_CLASS[suit]}">${card[0]}${SUIT_SYMBOL[suit]}</span>`;
  }

  // ---------------------------------------------------------------------
  // Baccarat/ClubGG-style squeeze: tap a small face-down trigger to open a bigger card,
  // then DRAG (not hold) to bend it open — drag distance drives a 3D rotateY flip, so you
  // see the card thin out edge-on around the halfway point ("how many sides") before the
  // true face appears past it. Release early and it snaps back face-down; drag far enough
  // (or let go past the lock angle) and it completes the flip.
  // ---------------------------------------------------------------------
  const SQUEEZE_DRAG_RANGE = 220;   // px of drag to go from fully-back (0°) to fully-open (180°)
  const SQUEEZE_LOCK_ANGLE = 150;   // release at/past this angle completes the flip instead of snapping back

  function renderSqueezeControl(boardIndex, card, onComplete) {
    el('revealControls').innerHTML = '';
    const block = document.createElement('div');
    block.className = 'control-block';
    const label = document.createElement('div');
    label.className = 'control-label';
    label.textContent = `River — Board ${boardIndex === 0 ? 'A' : 'B'} — tap to squeeze`;
    block.appendChild(label);
    block.appendChild(createSqueezeTrigger(card, onComplete));
    el('revealControls').appendChild(block);
  }

  // `card` may be null — in multiplayer the server never sends an unrevealed card's value to
  // ANY client (not even the host), so the squeeze plays out not knowing its own face until
  // the drag completes and the server confirms the reveal; the caller swaps in the real
  // board state (via renderBoards, once the server responds) after that.
  function createSqueezeTrigger(card, onComplete) {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'squeeze-trigger';
    trigger.setAttribute('aria-label', 'Tap to squeeze the river');
    trigger.innerHTML = '<span class="squeeze-trigger-mark">?</span><span class="squeeze-trigger-hint">Tap to squeeze</span>';
    trigger.addEventListener('click', () => openSqueezeModal(card, onComplete));
    return trigger;
  }

  function openSqueezeModal(card, onComplete) {
    const rank = card ? card[0] : '?';
    const suit = card ? card[1] : null;

    const overlay = document.createElement('div');
    overlay.className = 'squeeze-overlay';

    const stage = document.createElement('div');
    stage.className = 'squeeze-stage';

    const hint = document.createElement('div');
    hint.className = 'squeeze-hint';
    hint.textContent = 'Drag to peel it open — let go early and it snaps back';

    const cardOuter = document.createElement('div');
    cardOuter.className = 'squeeze-card';

    const inner = document.createElement('div');
    inner.className = 'squeeze-inner';

    const back = document.createElement('div');
    back.className = 'squeeze-face squeeze-back';

    const face = document.createElement('div');
    face.className = 'squeeze-face squeeze-front' + (suit ? ' ' + SUIT_CLASS[suit] : '');
    face.innerHTML = suit
      ? `<span class="rank">${rank}</span><span class="suit">${SUIT_SYMBOL[suit]}</span>`
      : `<span class="rank">?</span>`;

    inner.appendChild(back);
    inner.appendChild(face);
    cardOuter.appendChild(inner);
    stage.appendChild(cardOuter);
    stage.appendChild(hint);
    overlay.appendChild(stage);
    document.body.appendChild(overlay);

    let angle = 0;
    let dragging = false;
    let startX = 0;
    let startAngle = 0;
    let locked = false;

    function applyAngle(a) {
      angle = Math.max(0, Math.min(180, a));
      inner.style.transform = `rotateY(${angle}deg)`;
      // How "edge-on" the card looks right now (1 at 90°, where you're seeing it side-on —
      // "how many sides" — and 0 at either face) drives a subtle width/shadow pinch.
      const edgeOn = Math.sin((angle * Math.PI) / 180);
      cardOuter.style.setProperty('--edge-factor', (1 - edgeOn * 0.55).toFixed(3));
    }

    function cleanup() {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    }

    function finishLock() {
      if (locked) return;
      locked = true;
      cleanup();
      inner.style.transition = 'transform .18s ease-out';
      applyAngle(180);
      setTimeout(() => {
        overlay.classList.add('squeeze-closing');
        setTimeout(() => {
          overlay.remove();
          onComplete();
        }, 180);
      }, 160);
    }

    function snapBack() {
      inner.style.transition = 'transform .22s ease-out';
      applyAngle(0);
    }

    function onPointerDown(e) {
      if (locked) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startAngle = angle;
      inner.style.transition = 'none';
      try { cardOuter.setPointerCapture(e.pointerId); } catch (err) { /* ignore — not critical */ }
    }
    function onPointerMove(e) {
      if (!dragging || locked) return;
      const dx = e.clientX - startX;
      applyAngle(startAngle + (dx / SQUEEZE_DRAG_RANGE) * 180);
      if (angle >= 180) finishLock();
    }
    function onPointerUp() {
      if (!dragging || locked) return;
      dragging = false;
      if (angle >= SQUEEZE_LOCK_ANGLE) finishLock();
      else snapBack();
    }

    cardOuter.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    applyAngle(0);
  }

  // =======================================================================
  // MULTIPLAYER — a real room on the server (lib/rooms.js via the /api/rooms/*
  // endpoints in server.js), so a link can actually be shared: each seat is a different
  // browser/device, your own 7 cards stay secret from everyone else until the whole table
  // is ready (then hands are "tabled" — shown to everyone, like a real sweat — and the
  // board reveal that follows paces itself on the server's own clock and is mirrored to
  // every viewer).
  //
  // The host's own squeeze completion updates local state immediately (so the host's UI
  // never waits on its own round-trip for that), and a single poll loop keeps everyone
  // (host included, for seat-list/presence and as a safety net) in sync the rest of the
  // time. A small monotonic guard (sweatKeyFor + "never apply a stageIndex that's older
  // than what we've already shown") stops a slow/late poll response from ever visually
  // rolling the reveal backwards.
  // =======================================================================
  const MP_SESSION_KEY = 'sweat-room-mp-session';
  // Tests set window.__SWEAT_ROOM_FAST_TIMERS__ to shrink the server's own auto-pacing
  // holds down to milliseconds (see lib/rooms.js) — polling at the normal production
  // cadence would then miss most of the intermediate stages entirely, racing straight to
  // the end before ever observing them, so the poll speeds up to match.
  const MP_POLL_MS = CLIENT_FAST ? 10 : 1200;

  const mp = {
    code: null,
    playerId: null,
    hand: null,            // this browser's own 7 dealt cards (never anyone else's)
    assignment: null,      // { one:[], two:[], four:[] } — local until "I'm Ready" submits it
    selectedCard: null,
    arrangingInitialized: false,
    enteredSweat: false,
    lastAppliedSweatKey: null,
    lastRoom: null,
    pollTimer: null
  };

  async function mpApi(method, path, body) {
    try {
      const res = await fetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { error: (json && json.error) || `Request failed (${res.status}).` };
      return json;
    } catch (e) {
      return { error: 'Could not reach the server — check your connection and try again.' };
    }
  }

  function sweatKeyFor(room) {
    return [
      room.stageIndex,
      room.revealedA,
      room.revealedB,
      room.pendingSwing ? room.pendingSwing.boardIndex + ':' + room.pendingSwing.hasSwing : 'none'
    ].join('|');
  }

  function startMpPolling() {
    stopMpPolling();
    mp.pollTimer = setInterval(async () => {
      if (!mp.code || !mp.playerId) return;
      const resp = await mpApi('GET', `/api/rooms/${mp.code}?playerId=${encodeURIComponent(mp.playerId)}`);
      if (resp.error) return; // transient network hiccup — just try again next tick
      handleMpRoomUpdate(resp.room);
    }, MP_POLL_MS);
  }
  function stopMpPolling() {
    if (mp.pollTimer) { clearInterval(mp.pollTimer); mp.pollTimer = null; }
  }

  function showMpScreenPanel(which) {
    if (which === 'sweat') {
      hide('mpScreen');
      show('sweatScreen');
      return;
    }
    hide('sweatScreen');
    show('mpScreen');
    el('mpEntryPanel').classList.add('hidden');
    el('mpLobbyPanel').classList.toggle('hidden', which !== 'lobby');
    el('mpArrangePanel').classList.toggle('hidden', which !== 'arranging');
  }

  // The single dispatcher every room update (the host's own action responses, and every
  // poll tick for everyone) runs through — keeps the lobby/arranging/sweat screens in sync
  // with whatever the server says is actually true.
  function handleMpRoomUpdate(room) {
    mp.lastRoom = room;

    if (room.phase === 'lobby') {
      mp.arrangingInitialized = false;
      mp.enteredSweat = false;
      mp.lastAppliedSweatKey = null;
      showMpScreenPanel('lobby');
      renderMpLobby(room);
      return;
    }

    if (room.phase === 'arranging') {
      mp.enteredSweat = false;
      mp.lastAppliedSweatKey = null;
      showMpScreenPanel('arranging');
      if (!mp.arrangingInitialized) {
        mp.arrangingInitialized = true;
        mp.hand = room.yourHand || mp.hand || [];
        mp.assignment = { one: [], two: [], four: [] };
        mp.selectedCard = null;
        renderMpArranger();
      }
      renderMpArrangeStatus(room);
      return;
    }

    if (room.phase === 'sweat') {
      if (!mp.enteredSweat) {
        mp.enteredSweat = true;
        showMpScreenPanel('sweat');
      }
      const regressing = sweat.mode === 'mp' && sweat.mpCode === room.code && room.stageIndex < sweat.stageIndex;
      const key = sweatKeyFor(room);
      if (!regressing && key !== mp.lastAppliedSweatKey) {
        mp.lastAppliedSweatKey = key;
        applyRoomToSweat(room);
        renderBoards();
        renderStage();
        recomputeStanding();
      }
    }
  }

  function applyRoomToSweat(room) {
    sweat.mode = 'mp';
    sweat.mpCode = room.code;
    sweat.mpIsHost = room.isHost;
    sweat.mpHostId = room.hostId;
    sweat.homerunMode = room.homerunMode;
    sweat.players = room.players.map((p) => ({ id: p.id, name: p.name, assignment: p.assignment }));
    sweat.boardA = room.boardA;
    sweat.boardB = room.boardB;
    sweat.revealedA = room.revealedA;
    sweat.revealedB = room.revealedB;
    sweat.stageIndex = room.stageIndex;
    sweat.pendingSwing = room.pendingSwing;
    syncNewHandButtonVisibility();
  }

  // ---------------------------------------------------------------------
  // Lobby (room code, share link, seat list, host-only Deal button)
  // ---------------------------------------------------------------------
  function renderMpLobby(room) {
    el('mpRoomCodeLabel').textContent = room.code;
    el('mpRoomCode').textContent = room.code;
    el('mpShareLink').value = location.origin + location.pathname + '?room=' + room.code;

    const seatWrap = el('mpSeatList');
    seatWrap.innerHTML = '';
    room.players.forEach((p) => {
      const tag = document.createElement('div');
      tag.className = 'player-tab static';
      tag.innerHTML = `<span class="seat-dot ${p.connected ? 'connected' : ''}"></span>${escapeHtml(p.name)}`
        + (p.isHost ? '<span class="host-badge">HOST</span>' : '');
      seatWrap.appendChild(tag);
    });
    for (let i = room.players.length; i < room.capacity; i++) {
      const tag = document.createElement('div');
      tag.className = 'player-tab static';
      tag.style.opacity = '0.45';
      tag.textContent = 'Waiting for a player…';
      seatWrap.appendChild(tag);
    }

    const full = room.players.length === room.capacity;
    if (room.isHost) {
      el('btnMpDeal').classList.remove('hidden');
      el('btnMpDeal').disabled = !full;
      el('mpLobbyStatus').textContent = full
        ? "Everyone's here — deal when ready."
        : `Waiting for ${room.capacity - room.players.length} more player(s) to join…`;
    } else {
      el('btnMpDeal').classList.add('hidden');
      el('mpLobbyStatus').textContent = full
        ? 'Waiting for the host to deal…'
        : `Waiting for ${room.capacity - room.players.length} more player(s) to join…`;
    }
  }

  // ---------------------------------------------------------------------
  // Arranging your own single hand (same click-card-then-click-slot model as solo/reference)
  // ---------------------------------------------------------------------
  function mpTrayCards() {
    const used = new Set([...mp.assignment.one, ...mp.assignment.two, ...mp.assignment.four]);
    return sortCards(mp.hand.filter((c) => !used.has(c)), cardSortMode);
  }

  function updateMpReadyButton() {
    el('btnMpReady').disabled = G.validateAssignment(mp.hand, mp.assignment) !== null;
  }

  function renderMpArrangeStatus(room) {
    const readyCount = room.players.filter((p) => p.ready).length;
    el('mpArrangeStatus').textContent = `${readyCount}/${room.players.length} players ready`;
  }

  function renderMpArranger() {
    const asg = mp.assignment;
    const wrap = document.createElement('div');

    const slots = document.createElement('div');
    slots.className = 'slots';
    ZONES.forEach((zone) => {
      const slotDiv = document.createElement('div');
      slotDiv.className = 'slot';
      slotDiv.dataset.slot = zone;

      const title = document.createElement('div');
      title.className = 'slot-title';
      title.innerHTML = `${SLOT_TITLES[zone]} <span class="pt">worth ${G.POINTS[zone]} pt / board</span>`;
      slotDiv.appendChild(title);

      const cardsDiv = document.createElement('div');
      cardsDiv.className = 'slot-cards';
      asg[zone].forEach((c) => {
        const node = cardEl(c);
        node.addEventListener('click', (ev) => {
          ev.stopPropagation();
          asg[zone] = asg[zone].filter((x) => x !== c);
          mp.selectedCard = null;
          renderMpArranger();
        });
        cardsDiv.appendChild(node);
      });
      slotDiv.appendChild(cardsDiv);

      slotDiv.addEventListener('click', () => {
        if (!mp.selectedCard) return;
        if (asg[zone].length >= CAPACITY[zone]) return;
        asg[zone].push(mp.selectedCard);
        mp.selectedCard = null;
        renderMpArranger();
      });

      slots.appendChild(slotDiv);
    });
    wrap.appendChild(slots);

    const trayWrap = document.createElement('div');
    trayWrap.className = 'tray-wrap';

    const trayTitleRow = document.createElement('div');
    trayTitleRow.className = 'slot-title tray-title-row';
    const trayLabel = document.createElement('span');
    trayLabel.innerHTML = `Your Cards <span class="hint-inline">(click a card, then click a hand above &mdash; or &#8984;/Ctrl+click a card to drop it in the first open slot)</span>`;
    trayTitleRow.appendChild(trayLabel);

    const sortControl = document.createElement('span');
    sortControl.className = 'sort-control';
    const sortLabel = document.createElement('span');
    sortLabel.className = 'sort-label';
    sortLabel.textContent = 'Sort:';
    sortControl.appendChild(sortLabel);
    ['dealt', 'rank', 'suit'].forEach((mode) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sort-btn' + (cardSortMode === mode ? ' active' : '');
      btn.textContent = mode[0].toUpperCase() + mode.slice(1);
      btn.addEventListener('click', () => {
        if (cardSortMode === mode) return;
        cardSortMode = mode;
        try { localStorage.setItem(CARD_SORT_KEY, cardSortMode); } catch (e) { /* ignore */ }
        renderMpArranger();
      });
      sortControl.appendChild(btn);
    });
    trayTitleRow.appendChild(sortControl);
    trayWrap.appendChild(trayTitleRow);

    const tray = document.createElement('div');
    tray.className = 'tray';
    mpTrayCards().forEach((c) => {
      const node = cardEl(c);
      if (mp.selectedCard === c) node.classList.add('selected');
      node.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey) {
          placeInFirstOpenSlot(asg, c, CAPACITY);
          mp.selectedCard = null;
          renderMpArranger();
          return;
        }
        mp.selectedCard = mp.selectedCard === c ? null : c;
        renderMpArranger();
      });
      tray.appendChild(node);
    });
    trayWrap.appendChild(tray);
    wrap.appendChild(trayWrap);

    el('mpArrangerBody').innerHTML = '';
    el('mpArrangerBody').appendChild(wrap);

    updateMpReadyButton();
  }

  // ---------------------------------------------------------------------
  // Sweat — passive auto-paced status for everyone (host included), mirroring whatever the
  // server polls back; the only remaining action anyone ever takes here is the host
  // physically completing the squeeze on a river the server flagged as a swing spot.
  // ---------------------------------------------------------------------
  function showMpSweatError(msg) {
    const div = document.createElement('div');
    div.className = 'control-label';
    div.style.color = 'var(--danger)';
    div.textContent = msg;
    el('revealControls').appendChild(div);
  }

  function renderStageMp(stage) {
    renderOutsPanel(sweat.pendingSwing);
    el('revealControls').innerHTML = '';
    if (stage.id === 'done') {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">🏁 Showdown complete</div></div>`;
      return;
    }
    if (stage.id === 'flops' || stage.id === 'turnA' || stage.id === 'turnB') {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">${STAGE_PASSIVE_LABEL[stage.id]}</div></div>`;
      return;
    }
    // riverA / riverB
    const boardIndex = stage.board;
    const swing = sweat.pendingSwing;
    if (!swing || swing.boardIndex !== boardIndex) {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">Checking the river for outs…</div></div>`;
      return;
    }
    if (!swing.hasSwing) {
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">Revealing the river — Board ${boardIndex === 0 ? 'A' : 'B'}…</div></div>`;
      return;
    }
    // swing river — only the host ever squeezes; everyone else just watches
    if (sweat.mpIsHost) {
      // `card` is deliberately null — the real value only exists once the server confirms
      // the reveal (see createSqueezeTrigger's comment above).
      renderSqueezeControl(boardIndex, null, () => completeSqueezeMp(boardIndex));
    } else {
      const hostPlayer = sweat.players.find((p) => p.id === sweat.mpHostId);
      const hostName = hostPlayer ? hostPlayer.name : 'the host';
      el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">⏳ ${escapeHtml(hostName)} is squeezing the Board ${boardIndex === 0 ? 'A' : 'B'} river…</div></div>`;
    }
  }

  async function completeSqueezeMp(boardIndex) {
    const action = boardIndex === 0 ? 'riverA' : 'riverB';
    const resp = await mpApi('POST', `/api/rooms/${mp.code}/advance`, { playerId: mp.playerId, action });
    if (resp.error) {
      renderStage();
      showMpSweatError(resp.error);
      return;
    }
    mp.lastAppliedSweatKey = sweatKeyFor(resp.room);
    applyRoomToSweat(resp.room);
    renderBoards();
    await recomputeStanding();
    renderStage();
  }

  // ---------------------------------------------------------------------
  // Entry: mode screen, create/join forms, lobby wiring
  // ---------------------------------------------------------------------
  el('btnModeSolo').addEventListener('click', () => {
    hide('modeScreen');
    show('setupScreen');
  });
  el('btnModeMultiplayer').addEventListener('click', () => {
    hide('modeScreen');
    show('mpScreen');
  });

  function setMpEntryTab(tab) {
    el('mpEntryTabs').querySelectorAll('.pill-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    el('mpCreatePanel').classList.toggle('hidden', tab !== 'create');
    el('mpJoinPanel').classList.toggle('hidden', tab !== 'join');
    el('mpEntryError').textContent = '';
  }
  el('mpEntryTabs').querySelectorAll('.pill-btn').forEach((b) => {
    b.addEventListener('click', () => setMpEntryTab(b.dataset.tab));
  });
  setMpEntryTab('create');

  let mpCapacity = 2;
  el('mpCapacityGroup').querySelectorAll('.pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mpCapacity = Number(btn.dataset.count);
      el('mpCapacityGroup').querySelectorAll('.pill-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.count) === mpCapacity));
    });
  });
  el('mpCapacityGroup').querySelector('.pill-btn[data-count="2"]').classList.add('active');

  function saveMpSession() {
    try { localStorage.setItem(MP_SESSION_KEY, JSON.stringify({ code: mp.code, playerId: mp.playerId })); } catch (e) { /* ignore */ }
  }

  el('btnMpCreate').addEventListener('click', async () => {
    const hostName = el('mpHostName').value.trim();
    el('mpEntryError').textContent = '';
    el('btnMpCreate').disabled = true;
    const resp = await mpApi('POST', '/api/rooms', { hostName, capacity: mpCapacity, homerunMode: el('mpHomerunToggle').checked });
    el('btnMpCreate').disabled = false;
    if (resp.error) { el('mpEntryError').textContent = resp.error; return; }
    mp.code = resp.room.code;
    mp.playerId = resp.playerId;
    saveMpSession();
    handleMpRoomUpdate(resp.room);
    startMpPolling();
  });

  el('btnMpJoin').addEventListener('click', async () => {
    const name = el('mpJoinName').value.trim();
    const code = el('mpJoinCode').value.trim().toUpperCase();
    el('mpEntryError').textContent = '';
    if (!code) { el('mpEntryError').textContent = 'Enter a room code.'; return; }
    el('btnMpJoin').disabled = true;
    const resp = await mpApi('POST', `/api/rooms/${code}/join`, { name });
    el('btnMpJoin').disabled = false;
    if (resp.error) { el('mpEntryError').textContent = resp.error; return; }
    mp.code = resp.room.code;
    mp.playerId = resp.playerId;
    saveMpSession();
    handleMpRoomUpdate(resp.room);
    startMpPolling();
  });

  el('btnMpDeal').addEventListener('click', async () => {
    el('btnMpDeal').disabled = true;
    const resp = await mpApi('POST', `/api/rooms/${mp.code}/deal`, { playerId: mp.playerId });
    if (resp.error) { el('mpLobbyStatus').textContent = resp.error; el('btnMpDeal').disabled = false; return; }
    handleMpRoomUpdate(resp.room);
  });

  el('btnMpReady').addEventListener('click', async () => {
    if (G.validateAssignment(mp.hand, mp.assignment) !== null) return;
    el('btnMpReady').disabled = true;
    const resp = await mpApi('POST', `/api/rooms/${mp.code}/submit`, { playerId: mp.playerId, assignment: mp.assignment });
    if (resp.error) { el('mpArrangeStatus').textContent = resp.error; el('btnMpReady').disabled = false; return; }
    el('mpArrangerBody').innerHTML = '<p class="hint">Waiting for the rest of the table…</p>';
    handleMpRoomUpdate(resp.room);
  });

  el('btnMpCopyLink').addEventListener('click', async () => {
    const link = el('mpShareLink').value;
    try {
      await navigator.clipboard.writeText(link);
      const btn = el('btnMpCopyLink');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (e) {
      el('mpShareLink').select();
    }
  });

  // A shared link looks like /?room=AB3CD — land straight on the join form, prefilled.
  // Otherwise, if this browser already has a saved seat (e.g. the page was reloaded
  // mid-game), try to silently resume it instead of starting over at the mode screen.
  const roomParamFromUrl = new URLSearchParams(location.search).get('room');
  if (roomParamFromUrl) {
    hide('modeScreen');
    show('mpScreen');
    setMpEntryTab('join');
    el('mpJoinCode').value = roomParamFromUrl.toUpperCase();
  } else {
    (async function tryResumeMpSession() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(MP_SESSION_KEY) || 'null'); } catch (e) { /* ignore */ }
      if (!saved || !saved.code || !saved.playerId) return;
      const resp = await mpApi('GET', `/api/rooms/${saved.code}?playerId=${encodeURIComponent(saved.playerId)}`);
      if (resp.error) { try { localStorage.removeItem(MP_SESSION_KEY); } catch (e) { /* ignore */ } return; }
      mp.code = saved.code;
      mp.playerId = saved.playerId;
      hide('modeScreen');
      show('mpScreen');
      handleMpRoomUpdate(resp.room);
      startMpPolling();
    })();
  }
})();
