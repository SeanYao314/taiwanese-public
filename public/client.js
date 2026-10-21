// public/client.js — Sweat Room UI: hand setup/arranging, then the staged
// flop->turn->river sweat with live equity and the baccarat-style peel for swingy rivers.
// Depends on window.Poker, window.Game, window.Equity (loaded as plain <script> tags).
'use strict';

(function () {
  const P = window.Poker;
  const G = window.Game;
  const E = window.Equity;

  const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function isRedCard(card) { return card[1] === 'h' || card[1] === 'd'; }
  function suitSymbol(card) { return SUIT_SYMBOL[card[1]]; }
  function cardColorClass(card) { return isRedCard(card) ? 'red' : 'black'; }
  function cardInnerHTML(card) {
    return `<div>${card[0]}</div><div class="suit-big">${suitSymbol(card)}</div>`;
  }
  function cardHTML(card, extraClass) {
    return `<div class="card ${cardColorClass(card)} ${extraClass || ''}">${cardInnerHTML(card)}</div>`;
  }
  function cardBackHTML() { return `<div class="card-back"></div>`; }
  function outChipHTML(card) {
    return `<span class="out-chip ${cardColorClass(card)}">${card[0]}${suitSymbol(card)}</span>`;
  }

  const ZONES = ['one', 'two', 'four'];
  const ZONE_LABEL = { one: '1-Card', two: '2-Card', four: '4-Card PLO' };

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
    activeZone: 'one'
  };

  const els = {};
  [
    'playerCountGroup', 'playerNameInputs', 'homerunToggle', 'btnDeal',
    'preDealPanel', 'arrangePanel', 'playerTabs', 'arrangerBody',
    'btnRedeal', 'btnSweat',
    'sweatScreen', 'setupScreen',
    'boardACards', 'boardBCards', 'boardATitle', 'boardBTitle',
    'revealControls', 'outsPanel', 'equityPanel', 'handsPanel', 'btnNewHand'
  ].forEach((id) => { els[id] = document.getElementById(id); });

  // ---------------------------------------------------------------------
  // Setup screen rendering
  // ---------------------------------------------------------------------
  function renderPlayerCountGroup() {
    els.playerCountGroup.querySelectorAll('.pill-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.count) === setup.playerCount);
    });
  }

  function renderNameInputs() {
    els.playerNameInputs.innerHTML = '';
    for (let i = 0; i < setup.playerCount; i++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = setup.names[i];
      input.placeholder = `Player ${i + 1}`;
      input.addEventListener('input', () => { setup.names[i] = input.value.trim() || `Player ${i + 1}`; });
      els.playerNameInputs.appendChild(input);
    }
  }

  els.playerCountGroup.querySelectorAll('.pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setup.playerCount = Number(btn.dataset.count);
      renderPlayerCountGroup();
      renderNameInputs();
    });
  });
  els.homerunToggle.addEventListener('change', () => { setup.homerunMode = els.homerunToggle.checked; });

  renderPlayerCountGroup();
  renderNameInputs();

  // ---------------------------------------------------------------------
  // Dealing
  // ---------------------------------------------------------------------
  function dealNewHand() {
    setup.ids = [];
    for (let i = 0; i < setup.playerCount; i++) setup.ids.push('p' + i);
    setup.dealt = G.dealHand(setup.ids, 7);
    setup.assignments = {};
    setup.ids.forEach((id) => { setup.assignments[id] = { one: [], two: [], four: [] }; });
    setup.activePlayerIdx = 0;
    setup.activeZone = 'one';

    els.preDealPanel.classList.add('hidden');
    els.arrangePanel.classList.remove('hidden');
    renderPlayerTabs();
    renderArranger();
  }

  els.btnDeal.addEventListener('click', dealNewHand);
  els.btnRedeal.addEventListener('click', () => {
    els.arrangePanel.classList.add('hidden');
    els.preDealPanel.classList.remove('hidden');
    setup.dealt = null;
  });

  // ---------------------------------------------------------------------
  // Arranger
  // ---------------------------------------------------------------------
  function playerIsValid(id) {
    return G.validateAssignment(setup.dealt.hands[id], setup.assignments[id]) === null;
  }

  function allPlayersValid() {
    return setup.ids.length > 0 && setup.ids.every(playerIsValid);
  }

  function renderPlayerTabs() {
    els.playerTabs.innerHTML = '';
    setup.ids.forEach((id, idx) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'player-tab' + (idx === setup.activePlayerIdx ? ' active' : '') + (playerIsValid(id) ? ' valid' : '');
      tab.innerHTML = `${escapeHtml(setup.names[idx])} <span class="check">✓</span>`;
      tab.addEventListener('click', () => {
        setup.activePlayerIdx = idx;
        setup.activeZone = 'one';
        renderPlayerTabs();
        renderArranger();
      });
      els.playerTabs.appendChild(tab);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getTray(id) {
    const hand = setup.dealt.hands[id];
    const asg = setup.assignments[id];
    const used = new Set([...asg.one, ...asg.two, ...asg.four]);
    return hand.filter((c) => !used.has(c)).sort((a, b) => P.rankValue(b) - P.rankValue(a));
  }

  function renderArranger() {
    const id = setup.ids[setup.activePlayerIdx];
    const asg = setup.assignments[id];
    const tray = getTray(id);

    const zonePicker = document.createElement('div');
    zonePicker.className = 'zone-picker';
    ZONES.forEach((zone) => {
      const cap = G.STANDARD_CAPACITY[zone];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'zone-btn' + (setup.activeZone === zone ? ' active' : '');
      btn.innerHTML = `${ZONE_LABEL[zone]} <span class="count">(${asg[zone].length}/${cap})</span>`;
      btn.addEventListener('click', () => { setup.activeZone = zone; renderArranger(); });
      zonePicker.appendChild(btn);
    });

    const slotsArea = document.createElement('div');
    slotsArea.className = 'slots-area';
    ZONES.forEach((zone) => {
      const cap = G.STANDARD_CAPACITY[zone];
      const group = document.createElement('div');
      group.className = 'slot-group';
      const label = document.createElement('div');
      label.className = 'slot-group-label';
      label.textContent = `${ZONE_LABEL[zone]} (${asg[zone].length}/${cap})`;
      group.appendChild(label);
      const cardsRow = document.createElement('div');
      cardsRow.className = 'slot-cards';
      for (let i = 0; i < cap; i++) {
        const card = asg[zone][i];
        if (card) {
          const el = document.createElement('div');
          el.innerHTML = cardHTML(card, 'placed');
          el.firstChild.addEventListener('click', () => {
            asg[zone].splice(i, 1);
            setup.activeZone = zone; // so the freed slot is immediately where the next tray tap lands
            renderArranger();
            renderPlayerTabs();
            updateSweatButton();
          });
          cardsRow.appendChild(el.firstChild);
        } else {
          const ph = document.createElement('div');
          ph.className = 'slot-placeholder';
          cardsRow.appendChild(ph);
        }
      }
      group.appendChild(cardsRow);
      slotsArea.appendChild(group);
    });

    const trayLabel = document.createElement('div');
    trayLabel.className = 'tray-label';
    trayLabel.textContent = tray.length ? 'Tap a card, then tap where it goes:' : 'All cards placed.';

    const trayRow = document.createElement('div');
    trayRow.className = 'tray-cards';
    tray.forEach((card) => {
      const el = document.createElement('div');
      el.innerHTML = cardHTML(card);
      el.firstChild.addEventListener('click', () => {
        const cap = G.STANDARD_CAPACITY[setup.activeZone];
        if (asg[setup.activeZone].length >= cap) return;
        asg[setup.activeZone].push(card);
        renderArranger();
        renderPlayerTabs();
        updateSweatButton();
      });
      trayRow.appendChild(el.firstChild);
    });

    els.arrangerBody.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'arranger';
    wrap.appendChild(zonePicker);
    wrap.appendChild(slotsArea);
    wrap.appendChild(trayLabel);
    wrap.appendChild(trayRow);
    els.arrangerBody.appendChild(wrap);
  }

  function updateSweatButton() {
    els.btnSweat.disabled = !allPlayersValid();
  }

  els.btnSweat.addEventListener('click', () => {
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

    els.setupScreen.classList.add('hidden');
    els.sweatScreen.classList.remove('hidden');
    els.boardATitle.textContent = 'Board A';
    els.boardBTitle.textContent = 'Board B';
    els.outsPanel.classList.add('hidden');
    els.equityPanel.innerHTML = '';
    renderBoards();
    renderHandsPanel(null);
    renderStage();
  }

  els.btnNewHand.addEventListener('click', () => {
    els.sweatScreen.classList.add('hidden');
    els.setupScreen.classList.remove('hidden');
    els.preDealPanel.classList.remove('hidden');
    els.arrangePanel.classList.add('hidden');
    setup.dealt = null;
  });

  function renderBoards() {
    els.boardACards.innerHTML = sweat.boardA.map((c, i) => i < sweat.revealedA ? cardHTML(c) : cardBackHTML()).join('');
    els.boardBCards.innerHTML = sweat.boardB.map((c, i) => i < sweat.revealedB ? cardHTML(c) : cardBackHTML()).join('');
  }

  // ---------------------------------------------------------------------
  // Equity panel
  // ---------------------------------------------------------------------
  async function recomputeEquity() {
    const loadingLine = document.createElement('div');
    loadingLine.className = 'hint';
    loadingLine.textContent = 'Working out the odds…';
    els.equityPanel.innerHTML = '';
    els.equityPanel.appendChild(loadingLine);
    const boardAKnown = sweat.boardA.slice(0, sweat.revealedA);
    const boardBKnown = sweat.boardB.slice(0, sweat.revealedB);
    const result = await E.computeStageEquity({
      players: sweat.players,
      boardAKnown,
      boardBKnown,
      homerunMode: sweat.homerunMode,
      onProgress: (frac) => {
        if (loadingLine.isConnected) loadingLine.textContent = `Working out the odds… ${Math.round(frac * 100)}%`;
      }
    });
    renderEquity(result);
  }

  function renderEquity(result) {
    const catKeys = [];
    ['A', 'B'].forEach((b) => ['one', 'two', 'four'].forEach((c) => catKeys.push(b + '.' + c)));

    let html = '';
    sweat.players.forEach((p) => {
      const win = (result.winPct[p.id] * 100).toFixed(1);
      const ep = result.expectedPoints[p.id];
      const epStr = (ep > 0 ? '+' : '') + ep.toFixed(2);
      html += `<div class="equity-row">
        <div class="equity-head"><span class="pname">${escapeHtml(p.name)}</span>
          <span class="stats">Win ${win}% &middot; Exp. pts ${epStr}</span></div>
        <div class="equity-bar-track"><div class="equity-bar-fill" style="width:${win}%"></div></div>
        <div class="cat-grid">
          ${catKeys.map((k) => {
            const pct = (result.categoryWinPct[p.id][k] * 100).toFixed(0);
            return `<span class="${pct >= 50 ? 'cat-best' : ''}">${k.replace('one', '1C').replace('two', '2C').replace('four', '4C')}: ${pct}%</span>`;
          }).join('')}
        </div>
      </div>`;
    });
    const modeNote = result.mode === 'exact' ? `exact over ${result.trialsUsed.toLocaleString()} outcomes`
      : result.mode === 'sampled' ? `sampled, ${result.trialsUsed.toLocaleString()} trials`
      : 'final result';
    html += `<div class="equity-note">${modeNote}</div>`;
    els.equityPanel.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Hands panel (always-visible reference to each player's arrangement)
  // ---------------------------------------------------------------------
  function renderHandsPanel(finalEvals) {
    let html = '';
    sweat.players.forEach((p) => {
      html += `<div class="hand-card-box"><h4>${escapeHtml(p.name)}</h4>`;
      ZONES.forEach((zone) => {
        html += `<div class="hand-row"><span class="label">${ZONE_LABEL[zone]}</span><span class="hand-cards">${
          p.assignment[zone].map((c) => cardHTML(c, 'static')).join('')
        }</span></div>`;
      });
      if (finalEvals) {
        const ev = finalEvals[p.id];
        html += `<div class="hand-row" style="margin-top:8px;"><span class="label">Board A</span><span style="font-size:0.78rem;color:var(--text-dim);">${
          ZONES.map((z) => P.categoryName(ev[z][0].score)).join(' / ')
        }</span></div>`;
        html += `<div class="hand-row"><span class="label">Board B</span><span style="font-size:0.78rem;color:var(--text-dim);">${
          ZONES.map((z) => P.categoryName(ev[z][1].score)).join(' / ')
        }</span></div>`;
      }
      html += `</div>`;
    });
    els.handsPanel.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Outs panel
  // ---------------------------------------------------------------------
  function renderOutsPanel(swing) {
    if (!swing || !swing.hasSwing || swing.outs.length === 0) {
      els.outsPanel.classList.add('hidden');
      els.outsPanel.innerHTML = '';
      return;
    }
    const byBeneficiary = {};
    swing.outs.forEach((out) => {
      (byBeneficiary[out.beneficiary] = byBeneficiary[out.beneficiary] || []).push(out);
    });
    let html = `<h4>⚠ This river can swing the hand ${swing.swingThreshold}+ points — here are the outs</h4>`;
    Object.keys(byBeneficiary).forEach((pid) => {
      const player = sweat.players.find((p) => p.id === pid);
      const outs = byBeneficiary[pid].sort((a, b) => b.maxAbsDelta - a.maxAbsDelta);
      html += `<div class="outs-group"><b>${escapeHtml(player ? player.name : pid)}</b> gains up to +${outs[0].maxAbsDelta.toFixed(1)} pts with:
        <span class="outs-cards">${outs.map((o) => outChipHTML(o.card)).join('')}</span></div>`;
    });
    els.outsPanel.innerHTML = html;
    els.outsPanel.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Reveal controls / stage driver
  // ---------------------------------------------------------------------
  function renderStage() {
    const stage = REVEAL_STAGES[sweat.stageIndex];
    if (stage.id === 'flops') {
      renderFlopsControl();
    } else if (stage.id === 'turnA' || stage.id === 'turnB') {
      renderTurnControl(stage.board, stage.id === 'turnA' ? 'riverA-pending' : null);
    } else if (stage.id === 'riverA' || stage.id === 'riverB') {
      renderRiverStage(stage.board);
    } else {
      renderDoneStage();
    }
  }

  function renderFlopsControl() {
    els.revealControls.innerHTML = '';
    const block = document.createElement('div');
    block.className = 'control-block';
    const label = document.createElement('div');
    label.className = 'control-label';
    label.textContent = 'Both flops, revealed together';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-btn';
    btn.textContent = 'Reveal Both Flops';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      sweat.revealedA = 3;
      sweat.revealedB = 3;
      renderBoards();
      await recomputeEquity();
      sweat.stageIndex = 1;
      renderStage();
    });
    block.appendChild(label);
    block.appendChild(btn);
    els.revealControls.appendChild(block);
  }

  function renderTurnControl(boardIndex) {
    els.revealControls.innerHTML = '';
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
      await recomputeEquity();
      sweat.stageIndex += 1;
      renderStage();
    });
    block.appendChild(label);
    block.appendChild(btn);
    els.revealControls.appendChild(block);
  }

  async function renderRiverStage(boardIndex) {
    els.revealControls.innerHTML = `<div class="control-block"><div class="control-label">Checking the river for outs…</div></div>`;
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

  function completeRiver(boardIndex) {
    return async () => {
      if (boardIndex === 0) sweat.revealedA = 5; else sweat.revealedB = 5;
      renderBoards();
      els.outsPanel.classList.add('hidden');
      await recomputeEquity();
      sweat.stageIndex += 1;
      renderStage();
    };
  }

  function renderRiverControl(boardIndex, hasSwing) {
    els.revealControls.innerHTML = '';
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
    els.revealControls.appendChild(block);
  }

  async function renderDoneStage() {
    els.revealControls.innerHTML = `<div class="control-block"><div class="control-label">🏁 Showdown complete</div></div>`;
    const results = G.computeResults(sweat.players, [sweat.boardA, sweat.boardB], sweat.homerunMode);
    renderHandsPanel(results.evals);
    await recomputeEquity();
    if (results.homeruns.length) {
      const names = results.homeruns.map((h) => {
        const w = sweat.players.find((p) => p.id === h.winner);
        return w ? w.name : h.winner;
      });
      els.equityPanel.innerHTML += `<div class="outs-panel" style="margin-top:12px;"><h4>🏠 Homerun! ${escapeHtml(names.join(', '))} swept every comparison against an opponent — that match's points were doubled.</h4></div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Baccarat-style hold-to-peel card
  // ---------------------------------------------------------------------
  function createPeelCard(card, onComplete) {
    const wrapper = document.createElement('div');
    wrapper.className = 'peel-card';

    const face = document.createElement('div');
    face.className = 'peel-face ' + cardColorClass(card);
    face.innerHTML = cardInnerHTML(card);

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
      if (progress >= 1) {
        lock();
        return;
      }
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
