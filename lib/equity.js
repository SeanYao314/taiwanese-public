// lib/equity.js — the live-equity engine behind the Sweat Room reveal: given however
// much of both boards is currently known, estimate each player's chance to finish with
// the most points (win%) and their expected point total, plus a per-river "swing/outs"
// check used to decide when a river gets the dramatic hold-to-peel treatment.
//
// Exact math where it's cheap, Monte Carlo sampling where exact enumeration would be too
// slow for the browser — same philosophy as Practice Mode's EV engine in the sibling
// Taiwanese Poker project, just applied to "how much of the board is still hidden" instead
// of "how much of the opponent's strategy is still hidden." Pure logic, no DOM — shared
// between the Node test suite and the browser client (loaded as window.Equity).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./poker.js'), require('./game.js'));
  } else {
    root.Equity = factory(root.Poker, root.Game);
  }
})(typeof self !== 'undefined' ? self : this, function (P, G) {
  'use strict';

  function unseenDeck(knownCardsFlat) {
    const known = new Set(knownCardsFlat);
    return P.freshDeck().filter((c) => !known.has(c));
  }

  // n! / (n-k)! — the number of ORDERED ways to draw k distinct cards from a pool of n.
  // We enumerate/sample ordered draws (not combinations) because the first `needA` cards
  // of a draw go to board A and the rest to board B — two draws that differ only in which
  // card lands first within the same board produce the same final board anyway, so no
  // double-counting bias results from treating order as meaningful here.
  function permCount(n, k) {
    if (k <= 0) return 1;
    if (k > n) return 0;
    let total = 1;
    for (let i = 0; i < k; i++) total *= (n - i);
    return total;
  }

  // All ordered k-permutations of `pool`, as an array of k-length arrays. Only ever
  // called when permCount(pool.length, k) is small (see EXACT_THRESHOLD below) — this is
  // not meant to scale to large pools.
  function enumerateExact(pool, k) {
    const results = [];
    const n = pool.length;
    const combo = [];
    const used = new Array(n).fill(false);
    function recurse() {
      if (combo.length === k) {
        results.push(combo.slice());
        return;
      }
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        used[i] = true;
        combo.push(pool[i]);
        recurse();
        combo.pop();
        used[i] = false;
      }
    }
    if (k > 0) recurse();
    return results;
  }

  // One random ordered draw of k distinct cards from `pool`, via partial Fisher-Yates
  // (doesn't mutate pool).
  function drawRandom(pool, k) {
    const arr = pool.slice();
    const n = arr.length;
    const limit = Math.min(k, n);
    for (let i = 0; i < limit; i++) {
      const j = i + Math.floor(Math.random() * (n - i));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr.slice(0, limit);
  }

  function sleep0() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  const EXACT_THRESHOLD = 20000; // worlds — the ceiling when a caller pins maxExact explicitly
  // Each "world" costs one computeResults() call across every player/board/category, so this
  // is the main lever on how long a reveal's equity recompute takes in the browser (up to ~4
  // players, each evaluation ~90 evaluate5() calls per board). 1200 keeps win% within a couple
  // points of the exact answer (see tests/equity.test.js's sampled-mode tolerance) while staying
  // well under a second or two even on the heaviest (post-flop, 4-player) recompute.
  const DEFAULT_MC_TRIALS = 1200;
  const BATCH_SIZE = 150; // worlds evaluated per tick, to keep the UI responsive

  // evaluate5() calls per world scale with player count (each player is independently scored
  // against both boards: one(6) + two(21) + four(60) = 87 evaluations per board, times 2
  // boards). A flat EXACT_THRESHOLD of "20000 worlds" is fine at 2 players but catastrophic at
  // 3-4 — e.g. a 3-player, 12k-world case that would finish almost instantly at 2 players took
  // 15+ seconds once the per-world cost roughly tripled. Scale the default exact ceiling down
  // by player count so exact mode stays bounded by total WORK, not just world count; callers
  // that pass their own maxExact (as the test suite does, to force one path or the other) are
  // unaffected — this scaling only fills in when no maxExact is given.
  const EVALS_PER_WORLD_PER_PLAYER = 2 * (6 + 21 + 60); // 174
  const DEFAULT_EVAL_BUDGET = 150000; // ~0.3-0.4s of evaluate5() calls, see tests/equity.test.js timing notes
  function defaultExactCeiling(playerCount) {
    return Math.max(50, Math.floor(DEFAULT_EVAL_BUDGET / (playerCount * EVALS_PER_WORLD_PER_PLAYER)));
  }

  // Given the current known state of both boards, estimate every player's win% (chance
  // of finishing with the strictly-highest point total, ties splitting the credit) and
  // expected point total, plus a per-category "who's currently best" breakdown.
  //
  // players: [{ id, name, assignment }]   boardAKnown/boardBKnown: 3, 4, or 5 known cards
  async function computeStageEquity({ players, boardAKnown, boardBKnown, homerunMode, maxExact, mcTrials, onProgress }) {
    const needA = 5 - boardAKnown.length;
    const needB = 5 - boardBKnown.length;
    const needed = needA + needB;

    const allKnown = [];
    players.forEach((p) => allKnown.push(...p.assignment.one, ...p.assignment.two, ...p.assignment.four));
    allKnown.push(...boardAKnown, ...boardBKnown);

    const winCredit = {};
    const pointSum = {};
    const catWinCredit = {}; // catWinCredit[playerId]['A.one'] etc.
    const catKeys = [];
    ['A', 'B'].forEach((b) => ['one', 'two', 'four'].forEach((c) => catKeys.push(b + '.' + c)));
    players.forEach((p) => {
      winCredit[p.id] = 0;
      pointSum[p.id] = 0;
      catWinCredit[p.id] = {};
      catKeys.forEach((k) => { catWinCredit[p.id][k] = 0; });
    });

    function scoreOneWorld(fullBoardA, fullBoardB) {
      const r = G.computeResults(players, [fullBoardA, fullBoardB], homerunMode);
      let best = -Infinity;
      players.forEach((p) => { if (r.pointsByPlayer[p.id] > best) best = r.pointsByPlayer[p.id]; });
      const leaders = players.filter((p) => r.pointsByPlayer[p.id] === best);
      leaders.forEach((p) => { winCredit[p.id] += 1 / leaders.length; });
      players.forEach((p) => { pointSum[p.id] += r.pointsByPlayer[p.id]; });

      ['one', 'two', 'four'].forEach((cat) => {
        [0, 1].forEach((boardIdx) => {
          const label = (boardIdx === 0 ? 'A.' : 'B.') + cat;
          let bestScore = null;
          players.forEach((p) => {
            const s = r.evals[p.id][cat][boardIdx].score;
            if (bestScore === null || P.compareScores(s, bestScore) > 0) bestScore = s;
          });
          const catLeaders = players.filter((p) => P.compareScores(r.evals[p.id][cat][boardIdx].score, bestScore) === 0);
          catLeaders.forEach((p) => { catWinCredit[p.id][label] += 1 / catLeaders.length; });
        });
      });
    }

    let mode, worlds = null, trialsUsed;
    if (needed === 0) {
      mode = 'determined';
      trialsUsed = 1;
      scoreOneWorld(boardAKnown, boardBKnown);
    } else {
      const total = permCount(unseenDeck(allKnown).length, needed);
      const pool = unseenDeck(allKnown);
      const exactCeiling = maxExact || defaultExactCeiling(players.length);
      if (total <= exactCeiling) {
        mode = 'exact';
        worlds = enumerateExact(pool, needed);
        trialsUsed = worlds.length;
      } else {
        mode = 'sampled';
        trialsUsed = mcTrials || DEFAULT_MC_TRIALS;
      }

      let processed = 0;
      while (processed < trialsUsed) {
        const batchEnd = Math.min(trialsUsed, processed + BATCH_SIZE);
        for (let i = processed; i < batchEnd; i++) {
          const draw = worlds ? worlds[i] : drawRandom(pool, needed);
          const fullBoardA = boardAKnown.concat(draw.slice(0, needA));
          const fullBoardB = boardBKnown.concat(draw.slice(needA));
          scoreOneWorld(fullBoardA, fullBoardB);
        }
        processed = batchEnd;
        if (onProgress) onProgress(processed / trialsUsed);
        if (processed < trialsUsed) await sleep0();
      }
    }

    const winPct = {};
    const expectedPoints = {};
    const categoryWinPct = {};
    players.forEach((p) => {
      winPct[p.id] = winCredit[p.id] / trialsUsed;
      expectedPoints[p.id] = pointSum[p.id] / trialsUsed;
      categoryWinPct[p.id] = {};
      catKeys.forEach((k) => { categoryWinPct[p.id][k] = catWinCredit[p.id][k] / trialsUsed; });
    });

    return { mode, trialsUsed, winPct, expectedPoints, categoryWinPct };
  }

  // Before revealing one specific river card, check whether any possible value of that
  // card could swing some player's expected points by `swingThreshold` or more (default
  // 5), marginalizing over the OTHER board's own still-unknown river if it hasn't been
  // revealed yet (computeStageEquity already established the drawing order needed to make
  // this at most one card to marginalize over in Sweat Room's fixed Flop->TurnA->TurnB->
  // RiverA->RiverB sequence). Returns the specific "out" cards — the ones that actually
  // cross the threshold — tagged with who they help and by how much.
  //
  // boards: [boardA, boardB] arrays as CURRENTLY known, NOT including the pending card.
  // pendingBoardIndex: 0 or 1 — which board's river is about to be revealed.
  async function computeRiverSwing({ players, boards, pendingBoardIndex, homerunMode, swingThreshold, onProgress }) {
    const threshold = swingThreshold || 5;
    const otherIndex = pendingBoardIndex === 0 ? 1 : 0;
    const needOther = 5 - boards[otherIndex].length; // 0 if the other board is already fully known, else 1

    const allKnown = [];
    players.forEach((p) => allKnown.push(...p.assignment.one, ...p.assignment.two, ...p.assignment.four));
    allKnown.push(...boards[0], ...boards[1]);
    const pool = unseenDeck(allKnown);

    const candidates = [];
    let processed = 0;
    for (const card of pool) {
      const candidateSum = {};
      players.forEach((p) => { candidateSum[p.id] = 0; });
      let n = 0;

      function scoreWith(otherExtra) {
        const boardA = pendingBoardIndex === 0 ? boards[0].concat([card]) : boards[0].concat(otherExtra ? [otherExtra] : []);
        const boardB = pendingBoardIndex === 1 ? boards[1].concat([card]) : boards[1].concat(otherExtra ? [otherExtra] : []);
        const r = G.computeResults(players, [boardA, boardB], homerunMode);
        players.forEach((p) => { candidateSum[p.id] += r.pointsByPlayer[p.id]; });
        n += 1;
      }

      if (needOther === 0) {
        scoreWith(null);
      } else {
        const innerPool = pool.filter((c) => c !== card);
        for (const otherCard of innerPool) scoreWith(otherCard);
      }

      const expected = {};
      players.forEach((p) => { expected[p.id] = candidateSum[p.id] / n; });
      candidates.push({ card, expected });

      processed += 1;
      if (onProgress) onProgress(processed / pool.length);
      if (processed % 10 === 0) await sleep0();
    }

    const baseline = {};
    players.forEach((p) => { baseline[p.id] = 0; });
    candidates.forEach((c) => players.forEach((p) => { baseline[p.id] += c.expected[p.id]; }));
    players.forEach((p) => { baseline[p.id] /= candidates.length; });

    let hasSwing = false;
    candidates.forEach((c) => {
      c.delta = {};
      let maxAbs = 0;
      let beneficiary = null;
      let magnitude = 0;
      players.forEach((p) => {
        const d = c.expected[p.id] - baseline[p.id];
        c.delta[p.id] = d;
        if (Math.abs(d) > maxAbs) { maxAbs = Math.abs(d); beneficiary = p.id; magnitude = d; }
      });
      c.maxAbsDelta = maxAbs;
      c.beneficiary = beneficiary;
      c.magnitude = magnitude;
      c.isSwing = maxAbs >= threshold;
      if (c.isSwing) hasSwing = true;
    });

    const outs = candidates.filter((c) => c.isSwing).sort((a, b) => b.maxAbsDelta - a.maxAbsDelta);

    return { hasSwing, baseline, candidates, outs, swingThreshold: threshold };
  }

  return {
    EXACT_THRESHOLD,
    DEFAULT_MC_TRIALS,
    unseenDeck,
    permCount,
    enumerateExact,
    drawRandom,
    computeStageEquity,
    computeRiverSwing
  };
});
