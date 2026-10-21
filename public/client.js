// public/client.js — Sweat Room UI: hand setup/arranging (same click-a-card-then-click-a-box
// model as the Taiwanese Poker project), then the staged flop->turn->river sweat with a
// live, multiway-friendly scoreboard (per player, per category, per board) plus a live win%/
// projected-points line, and the baccarat-style peel for swingy rivers.
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

  const sweat = {
    players: [],      // [{id, name, assignment}]
    boardA: [],
    boardB: [],
    revealedA: 0,
    revealedB: 0,
    stageIndex: 0,
    homerunMode: false
  };

  function startSweat() {
    sweat.players = setup.ids.map((id, idx) => ({
      id, name: setup.names[idx], assignment: setup.assignments[id]
    }));
    sweat.boardA = setup.dealt.boards[0];
    sweat.boardB = setup.dealt.boards[1];
    sweat.revealedA = 0;
    sweat.revealedB = 0;
    sweat.stageIndex = 0;
    sweat.homerunMode = setup.homerunMode;

    hide('setupScreen');
    show('sweatScreen');
    el('outsPanel').classList.add('hidden');
    el('homerunBanner').classList.add('hidden');
    el('showdownExtras').classList.add('hidden');
    renderBoards();
    renderStage();
    recomputeStanding();
  }

  el('btnNewHand').addEventListener('click', () => {
    hide('sweatScreen');
    show('setupScreen');
    show('preDealPanel');
    hide('arrangePanel');
    setup.dealt = null;
  });

  function renderBoards() {
    const boardACards = el('boardACards');
    const boardBCards = el('boardBCards');
    boardACards.innerHTML = '';
    boardBCards.innerHTML = '';
    sweat.boardA.forEach((c, i) => boardACards.appendChild(i < sweat.revealedA ? cardEl(c) : cardBackEl()));
    sweat.boardB.forEach((c, i) => boardBCards.appendChild(i < sweat.revealedB ? cardEl(c) : cardBackEl()));
  }

  // ---------------------------------------------------------------------
  // Live standing (deterministic, "where do things stand right now") + equity
  // (probabilistic win%/projected points, looking ahead at what's still unseen)
  // ---------------------------------------------------------------------
  async function recomputeStanding() {
    const boardAKnown = sweat.boardA.slice(0, sweat.revealedA);
    const boardBKnown = sweat.boardB.slice(0, sweat.revealedB);
    const snapshot = G.computeLiveSnapshot(sweat.players, [boardAKnown, boardBKnown], sweat.homerunMode);
    renderPlayerResults(snapshot, null);

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

  function renderPlayerResults(snapshot, equity) {
    const cellPoints = cellPointTotals(snapshot);
    const wrap = el('resultsPlayers');
    wrap.innerHTML = '';

    sweat.players.forEach((p) => {
      const box = document.createElement('div');
      box.className = 'player-result';

      const head = document.createElement('div');
      head.className = 'player-result-head';
      const pname = document.createElement('span');
      pname.className = 'pname';
      pname.textContent = p.name;
      const homeruns = snapshot.homeruns.filter((h) => h.winner === p.id);
      if (homeruns.length) {
        const tag = document.createElement('span');
        tag.className = 'homerun-tag';
        tag.textContent = `⚾ HOMERUN${homeruns.length > 1 ? ' x' + homeruns.length : ''}`;
        pname.appendChild(tag);
      }
      const pts = snapshot.pointsByPlayer[p.id];
      const pscore = document.createElement('span');
      pscore.className = 'pscore ' + (pts > 0 ? 'pos' : pts < 0 ? 'neg' : '');
      pscore.textContent = fmtSigned(pts) + ' so far';
      head.appendChild(pname);
      head.appendChild(pscore);
      box.appendChild(head);

      const sub = document.createElement('div');
      sub.className = 'player-result-sub';
      sub.id = 'equityNote-' + p.id;
      sub.textContent = ' ';
      box.appendChild(sub);

      const preview = document.createElement('div');
      preview.className = 'hole-cards-preview';
      ZONES.forEach((cat) => {
        const group = document.createElement('span');
        group.className = 'hc-group';
        const lbl = document.createElement('span');
        lbl.className = 'hc-label';
        lbl.textContent = SLOT_TITLES[cat] + ':';
        group.appendChild(lbl);
        group.appendChild(cardRow(p.assignment[cat], { size: 'small', static: true }));
        preview.appendChild(group);
      });
      box.appendChild(preview);

      ZONES.forEach((cat) => {
        const row = document.createElement('div');
        row.className = 'cat-row';
        const labelDiv = document.createElement('div');
        labelDiv.className = 'cat-label';
        labelDiv.textContent = SLOT_TITLES[cat];
        row.appendChild(labelDiv);

        [0, 1].forEach((boardIndex) => {
          const evalInfo = snapshot.evals[p.id][cat][boardIndex];
          const cell = document.createElement('div');
          cell.className = 'board-eval';
          const boardLabel = boardIndex === 0 ? 'Board A: ' : 'Board B: ';

          const catName = document.createElement('span');
          catName.className = 'cat-name' + (evalInfo ? '' : ' pending');
          catName.textContent = boardLabel + (evalInfo ? P.categoryName(evalInfo.score) : 'needs more board cards…');
          cell.appendChild(catName);

          if (evalInfo) {
            const usedSet = new Set(evalInfo.cards);
            const handRow = cardRow(p.assignment[cat], { size: 'small', static: true });
            [...handRow.children].forEach((child, idx) => {
              if (usedSet.has(p.assignment[cat][idx])) child.classList.add('used-in-best');
            });
            cell.appendChild(document.createElement('br'));
            cell.appendChild(handRow);

            const current = cellPoints[p.id][cat][boardIndex];
            const ptsBadge = document.createElement('span');
            ptsBadge.className = 'cell-points ' + (current > 0 ? 'pos' : current < 0 ? 'neg' : 'even');
            ptsBadge.textContent = fmtSigned(current);
            cell.appendChild(ptsBadge);
            cell.classList.add(current > 0 ? 'cell-pos' : current < 0 ? 'cell-neg' : 'cell-even');
          }

          row.appendChild(cell);
        });

        box.appendChild(row);
      });

      wrap.appendChild(box);
    });

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

  function renderEquityNotes(loadingNotes, equity) {
    sweat.players.forEach((p) => {
      const sub = el('equityNote-' + p.id);
      if (!sub) return;
      if (loadingNotes) {
        sub.textContent = loadingNotes[p.id] || ' ';
        return;
      }
      if (!equity) return;
      if (equity.mode === 'determined') {
        sub.textContent = ' ';
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
  // Reveal controls / stage driver
  // ---------------------------------------------------------------------
  function renderStage() {
    const stage = REVEAL_STAGES[sweat.stageIndex];
    if (stage.id === 'flops') renderFlopsControl();
    else if (stage.id === 'turnA' || stage.id === 'turnB') renderTurnControl(stage.board);
    else if (stage.id === 'riverA' || stage.id === 'riverB') renderRiverStage(stage.board);
    else renderDoneStage();
  }

  function renderFlopsControl() {
    el('revealControls').innerHTML = '';
    const block = document.createElement('div');
    block.className = 'control-block';
    const label = document.createElement('div');
    label.className = 'control-label';
    label.textContent = 'Both flops, revealed together';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.style.width = 'auto';
    btn.textContent = 'Reveal Both Flops';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      sweat.revealedA = 3;
      sweat.revealedB = 3;
      renderBoards();
      sweat.stageIndex = 1;
      await recomputeStanding();
      renderStage();
    });
    block.appendChild(label);
    block.appendChild(btn);
    el('revealControls').appendChild(block);
  }

  function renderTurnControl(boardIndex) {
    el('revealControls').innerHTML = '';
    const block = document.createElement('div');
    block.className = 'control-block';
    const label = document.createElement('div');
    label.className = 'control-label';
    label.textContent = `Turn — Board ${boardIndex === 0 ? 'A' : 'B'}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reveal-card-btn';
    btn.addEventListener('click', async () => {
      btn.style.pointerEvents = 'none';
      if (boardIndex === 0) sweat.revealedA = 4; else sweat.revealedB = 4;
      renderBoards();
      sweat.stageIndex += 1;
      await recomputeStanding();
      renderStage();
    });
    block.appendChild(label);
    block.appendChild(btn);
    el('revealControls').appendChild(block);
  }

  async function renderRiverStage(boardIndex) {
    el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">Checking the river for outs…</div></div>`;
    const boards = [sweat.boardA.slice(0, sweat.revealedA), sweat.boardB.slice(0, sweat.revealedB)];
    const swing = await E.computeRiverSwing({
      players: sweat.players,
      boards,
      pendingBoardIndex: boardIndex,
      homerunMode: sweat.homerunMode
    });
    renderOutsPanel(swing);
    renderRiverControl(boardIndex, swing.hasSwing);
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

  function completeRiver(boardIndex) {
    return async () => {
      if (boardIndex === 0) sweat.revealedA = 5; else sweat.revealedB = 5;
      renderBoards();
      el('outsPanel').classList.add('hidden');
      sweat.stageIndex += 1;
      await recomputeStanding();
      renderStage();
    };
  }

  function renderRiverControl(boardIndex, hasSwing) {
    el('revealControls').innerHTML = '';
    const block = document.createElement('div');
    block.className = 'control-block';
    const label = document.createElement('div');
    label.className = 'control-label';
    label.textContent = hasSwing
      ? `River — Board ${boardIndex === 0 ? 'A' : 'B'} — hold to peel`
      : `River — Board ${boardIndex === 0 ? 'A' : 'B'}`;
    block.appendChild(label);

    const card = (boardIndex === 0 ? sweat.boardA : sweat.boardB)[boardIndex === 0 ? sweat.revealedA : sweat.revealedB];

    if (hasSwing) {
      block.appendChild(createPeelCard(card, completeRiver(boardIndex)));
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reveal-card-btn';
      btn.addEventListener('click', () => {
        btn.style.pointerEvents = 'none';
        completeRiver(boardIndex)();
      });
      block.appendChild(btn);
    }
    el('revealControls').appendChild(block);
  }

  function renderDoneStage() {
    el('revealControls').innerHTML = `<div class="control-block"><div class="control-label">🏁 Showdown complete</div></div>`;
  }

  // ---------------------------------------------------------------------
  // Baccarat-style hold-to-peel card
  // ---------------------------------------------------------------------
  function createPeelCard(card, onComplete) {
    const rank = card[0];
    const suit = card[1];

    const wrapper = document.createElement('div');
    wrapper.className = 'peel-card';

    const face = document.createElement('div');
    face.className = 'peel-face ' + SUIT_CLASS[suit];
    face.innerHTML = `<span class="rank">${rank}</span><span class="suit">${SUIT_SYMBOL[suit]}</span>`;

    const back = document.createElement('div');
    back.className = 'peel-back';

    const hint = document.createElement('div');
    hint.className = 'peel-hint';
    hint.textContent = 'Hold to peel';

    wrapper.appendChild(face);
    wrapper.appendChild(back);
    wrapper.appendChild(hint);

    const DURATION = 1300;
    const SNAPBACK_DURATION = 220;
    let progress = 0;
    let holding = false;
    let startTime = 0;
    let rafId = null;
    let done = false;

    function setProgress(p) {
      progress = Math.max(0, Math.min(1, p));
      back.style.clipPath = `inset(${(progress * 100).toFixed(2)}% 0 0 0)`;
      const lift = Math.min(progress, 0.3) / 0.3;
      wrapper.style.transform = `translateY(${-lift * 3}px) rotateZ(${-lift * 2}deg)`;
    }

    function tick(now) {
      if (!holding) return;
      const elapsed = now - startTime;
      setProgress(elapsed / DURATION);
      if (progress >= 1) { lock(); return; }
      rafId = requestAnimationFrame(tick);
    }

    function lock() {
      if (done) return;
      done = true;
      holding = false;
      wrapper.classList.add('locked');
      wrapper.style.transform = '';
      if (rafId) cancelAnimationFrame(rafId);
      onComplete();
    }

    function snapBack() {
      holding = false;
      if (rafId) cancelAnimationFrame(rafId);
      const from = progress;
      const start = performance.now();
      function snapTick(now) {
        if (done) return;
        const t = Math.min(1, (now - start) / SNAPBACK_DURATION);
        setProgress(from * (1 - t));
        if (t < 1) requestAnimationFrame(snapTick);
      }
      requestAnimationFrame(snapTick);
    }

    function onDown(e) {
      if (done) return;
      e.preventDefault();
      try { wrapper.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      holding = true;
      progress = 0;
      startTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
    function onUp() {
      if (done || !holding) return;
      if (progress < 1) snapBack();
    }

    wrapper.addEventListener('pointerdown', onDown);
    wrapper.addEventListener('pointerup', onUp);
    wrapper.addEventListener('pointercancel', onUp);
    wrapper.addEventListener('pointerleave', onUp);

    setProgress(0);
    return wrapper;
  }
})();
