// lib/game.js — pure game logic for Sweat Room: dealing, split validation, and the
// same zero-sum scoring engine as Taiwanese Poker's Standard variant (1-card/2-card/
// 4-card-PLO hands, two independent 5-card boards, optional homerun sweep bonus).
// Deliberately trimmed to just the Standard ruleset — no Pineapple, no Red River —
// since this tool is about sweating out a reveal, not every house variant.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./poker.js'));
  } else {
    root.Game = factory(root.Poker);
  }
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const POINTS = { one: 1, two: 2, four: 3 };
const CATEGORY_LABELS = { one: '1-Card Hand', two: '2-Card Hand', four: '4-Card PLO Hand' };
const STANDARD_BOARD_TOTAL = POINTS.one + POINTS.two + POINTS.four; // 6 — full sweep of one board, no bonus
const STANDARD_CAPACITY = { one: 1, two: 2, four: 4 };

// Deal 7 cards to each player id (array of ids) plus two independent 5-card boards,
// all from one shuffled 52-card deck, so no collisions are possible.
function dealHand(playerIds, handSize = 7) {
  const deck = P.shuffle(P.freshDeck());
  let idx = 0;
  const hands = {};
  for (const id of playerIds) {
    hands[id] = deck.slice(idx, idx + handSize);
    idx += handSize;
  }
  const boardA = deck.slice(idx, idx + 5);
  idx += 5;
  const boardB = deck.slice(idx, idx + 5);
  idx += 5;
  return { hands, boards: [boardA, boardB] };
}

// Validate that `assignment` ({one:[...], two:[...], four:[...]}) is a legal partition
// of exactly the dealt cards.
function validateAssignment(dealtCards, assignment, capacity = STANDARD_CAPACITY) {
  if (!assignment) return 'No arrangement submitted.';
  const { one, two, four } = assignment;
  if (!Array.isArray(one) || !Array.isArray(two) || !Array.isArray(four)) {
    return 'Malformed arrangement.';
  }
  if (one.length !== capacity.one) return `Your first hand must have exactly ${capacity.one} card${capacity.one === 1 ? '' : 's'}.`;
  if (two.length !== capacity.two) return `Your second hand must have exactly ${capacity.two} card${capacity.two === 1 ? '' : 's'}.`;
  if (four.length !== capacity.four) return `Your third hand must have exactly ${capacity.four} card${capacity.four === 1 ? '' : 's'}.`;

  const used = [...one, ...two, ...four];
  const total = capacity.one + capacity.two + capacity.four;
  if (used.length !== total) return `You must use all ${total} of your cards exactly once.`;
  const usedSet = new Set(used);
  if (usedSet.size !== total) return 'Duplicate card used in your arrangement.';
  const dealtSet = new Set(dealtCards);
  for (const c of used) {
    if (!dealtSet.has(c)) return `Card ${c} was not dealt to you.`;
  }
  return null; // valid
}

// Compute best-hand evaluations for one player's arrangement against both boards.
function evaluatePlayer(assignment, boards) {
  const out = { one: [], two: [], four: [] };
  for (const board of boards) {
    out.one.push(P.bestGeneric(assignment.one, board));
    out.two.push(P.bestGeneric(assignment.two, board));
    out.four.push(P.bestPLO(assignment.four, board));
  }
  return out;
}

// players: [{ id, name, assignment }]  boards: [board0, board1] (each a full 5-card array)
// homerunMode: sweeping ALL 6 comparisons against a given opponent (both boards, all 3
// categories, no ties anywhere) doubles the entire match total for that pairing.
// Returns { evals, comparisons, pointsByPlayer, homeruns }
function computeResults(players, boards, homerunMode = false) {
  const evals = {};
  const pointsByPlayer = {};
  for (const p of players) {
    evals[p.id] = evaluatePlayer(p.assignment, boards);
    pointsByPlayer[p.id] = 0;
  }

  const matchTotal = STANDARD_BOARD_TOTAL * boards.length; // 6 * 2 = 12 points max swing per pairing

  const comparisons = [];
  const homeruns = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const matchResults = [];
      for (let boardIndex = 0; boardIndex < boards.length; boardIndex++) {
        for (const category of ['one', 'two', 'four']) {
          const scoreA = evals[a.id][category][boardIndex].score;
          const scoreB = evals[b.id][category][boardIndex].score;
          const cmp = P.compareScores(scoreA, scoreB);
          const pts = POINTS[category];
          let winner = null;
          if (cmp > 0) {
            winner = a.id;
            pointsByPlayer[a.id] += pts;
            pointsByPlayer[b.id] -= pts;
          } else if (cmp < 0) {
            winner = b.id;
            pointsByPlayer[b.id] += pts;
            pointsByPlayer[a.id] -= pts;
          }
          const entry = { boardIndex, category, playerA: a.id, playerB: b.id, winner, points: pts };
          comparisons.push(entry);
          matchResults.push(entry);
        }
      }

      if (homerunMode) {
        const sweepWinner = matchResults.every((r) => r.winner === a.id)
          ? a.id
          : matchResults.every((r) => r.winner === b.id)
            ? b.id
            : null;
        if (sweepWinner) {
          const loser = sweepWinner === a.id ? b.id : a.id;
          pointsByPlayer[sweepWinner] += matchTotal;
          pointsByPlayer[loser] -= matchTotal;
          homeruns.push({ playerA: a.id, playerB: b.id, winner: sweepWinner });
        }
      }
    }
  }

  return { evals, comparisons, pointsByPlayer, homeruns };
}

  // Whether a category can be evaluated yet against a board that might not be fully dealt
  // out (mid-sweat, before all 5 cards of a board are known). The 1-card and 2-card hands
  // are "best 5 of the pool" (bestGeneric/bestOfPool), which needs a pool of at least 5
  // cards to form any 5-card hand at all — a 1-card hand can't make anything until the pool
  // (1 hole card + however many board cards are known) reaches 5, i.e. not until the turn.
  // A 2-card hand reaches that at the flop (2 + 3 = 5) and stays evaluable from then on. The
  // 4-card PLO hand only ever needs exactly 3 board cards (by rule), so it's evaluable from
  // the flop onward too.
  function canEvaluateCategory(category, handCards, board) {
    if (category === 'four') return board.length >= 3;
    return handCards.length + board.length >= 5;
  }

  // Same shape as evaluatePlayer, but tolerant of a board that isn't fully dealt out yet —
  // any (category, board) pair that can't be evaluated yet (see canEvaluateCategory) comes
  // back as null instead of throwing, so a caller can render "—" / "not yet" for it.
  function evaluatePlayerPartial(assignment, boards) {
    const out = { one: [], two: [], four: [] };
    for (const board of boards) {
      out.one.push(canEvaluateCategory('one', assignment.one, board) ? P.bestGeneric(assignment.one, board) : null);
      out.two.push(canEvaluateCategory('two', assignment.two, board) ? P.bestGeneric(assignment.two, board) : null);
      out.four.push(canEvaluateCategory('four', assignment.four, board) ? P.bestPLO(assignment.four, board) : null);
    }
    return out;
  }

  // "Where do things stand right now" — the live, mid-sweat counterpart to computeResults:
  // same zero-sum scoring, but over whatever's currently known of each board, skipping any
  // (category, board) comparison that isn't evaluable yet (see canEvaluateCategory) rather
  // than requiring full 5-card boards. A homerun is only ever credited for a pairing once
  // all 6 of its comparisons are actually decided (no pending slots) — never prematurely
  // off of however many happen to be known so far. Once every board is fully dealt out,
  // nothing is ever pending, so this produces exactly the same comparisons/points/homeruns
  // as computeResults — it's a strict generalization, not a different rule set.
  function computeLiveSnapshot(players, boards, homerunMode = false) {
    const evals = {};
    const pointsByPlayer = {};
    for (const p of players) {
      evals[p.id] = evaluatePlayerPartial(p.assignment, boards);
      pointsByPlayer[p.id] = 0;
    }

    const matchTotal = STANDARD_BOARD_TOTAL * boards.length;
    const comparisons = [];
    const homeruns = [];
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];
        const matchResults = [];
        let anyPending = false;
        for (let boardIndex = 0; boardIndex < boards.length; boardIndex++) {
          for (const category of ['one', 'two', 'four']) {
            const evalA = evals[a.id][category][boardIndex];
            const evalB = evals[b.id][category][boardIndex];
            if (!evalA || !evalB) { anyPending = true; continue; }
            const cmp = P.compareScores(evalA.score, evalB.score);
            const pts = POINTS[category];
            let winner = null;
            if (cmp > 0) {
              winner = a.id;
              pointsByPlayer[a.id] += pts;
              pointsByPlayer[b.id] -= pts;
            } else if (cmp < 0) {
              winner = b.id;
              pointsByPlayer[b.id] += pts;
              pointsByPlayer[a.id] -= pts;
            }
            const entry = { boardIndex, category, playerA: a.id, playerB: b.id, winner, points: pts };
            comparisons.push(entry);
            matchResults.push(entry);
          }
        }

        if (homerunMode && !anyPending && matchResults.length === 6) {
          const sweepWinner = matchResults.every((r) => r.winner === a.id)
            ? a.id
            : matchResults.every((r) => r.winner === b.id)
              ? b.id
              : null;
          if (sweepWinner) {
            const loser = sweepWinner === a.id ? b.id : a.id;
            pointsByPlayer[sweepWinner] += matchTotal;
            pointsByPlayer[loser] -= matchTotal;
            homeruns.push({ playerA: a.id, playerB: b.id, winner: sweepWinner });
          }
        }
      }
    }

    return { evals, comparisons, pointsByPlayer, homeruns };
  }

  return {
    POINTS,
    CATEGORY_LABELS,
    STANDARD_BOARD_TOTAL,
    STANDARD_CAPACITY,
    dealHand,
    validateAssignment,
    evaluatePlayer,
    computeResults,
    canEvaluateCategory,
    evaluatePlayerPartial,
    computeLiveSnapshot
  };
});
