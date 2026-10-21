// Dependency-free sanity checks for lib/game.js (dealing, validation, scoring).
// Run with: node tests/game.test.js
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'lib', 'game.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

// --- dealing ---
{
  const { hands, boards } = G.dealHand(['a', 'b', 'c'], 7);
  const allCards = [...hands.a, ...hands.b, ...hands.c, ...boards[0], ...boards[1]];
  assert(allCards.length === 31, 'dealHand: 3 players x 7 + 2 boards x 5 = 31 cards dealt');
  assert(new Set(allCards).size === 31, 'dealHand: every dealt card is unique, no collisions');
  assert(boards[0].length === 5 && boards[1].length === 5, 'dealHand: both boards are exactly 5 cards');
}

// --- validation ---
{
  const dealt = ['As', 'Kd', 'Qc', 'Jh', 'Ts', '9d', '8c'];
  const good = { one: ['As'], two: ['Kd', 'Qc'], four: ['Jh', 'Ts', '9d', '8c'] };
  assert(G.validateAssignment(dealt, good) === null, 'validateAssignment accepts a correct 1/2/4 partition');

  const wrongSize = { one: ['As', 'Kd'], two: ['Qc'], four: ['Jh', 'Ts', '9d', '8c'] };
  assert(typeof G.validateAssignment(dealt, wrongSize) === 'string', 'validateAssignment rejects wrong-sized hands');

  const foreignCard = { one: ['2h'], two: ['Kd', 'Qc'], four: ['Jh', 'Ts', '9d', '8c'] };
  assert(typeof G.validateAssignment(dealt, foreignCard) === 'string', 'validateAssignment rejects a card that was never dealt');

  const duplicate = { one: ['As'], two: ['As', 'Qc'], four: ['Jh', 'Ts', '9d', '8c'] };
  assert(typeof G.validateAssignment(dealt, duplicate) === 'string', 'validateAssignment rejects a reused card');
}

// --- scoring ---
{
  const boardA = ['2c', '5h', '9s', 'Jd', '2d'];
  const boardB = ['3c', '6h', 'Ts', 'Kd', '7d'];
  const players = [
    { id: 'alice', name: 'Alice', assignment: { one: ['As'], two: ['Kd', 'Qc'], four: ['Jh', 'Ts', '9d', '8c'] } },
    { id: 'bob', name: 'Bob', assignment: { one: ['2h'], two: ['3d', '4c'], four: ['5s', '6h', '7c', '8d'] } }
  ];
  const r = G.computeResults(players, [boardA, boardB], false);
  const sum = Object.values(r.pointsByPlayer).reduce((a, b) => a + b, 0);
  assert(sum === 0, 'computeResults is zero-sum for a heads-up hand');
  assert(r.comparisons.length === 6, 'computeResults produces 3 categories x 2 boards = 6 comparisons for 2 players');

  // Homerun bonus: deal random heads-up hands until one produces a clean 6-for-6 sweep
  // under plain scoring (pointsByPlayer === +-12, the max possible with zero ties), then
  // confirm turning homerunMode on for that EXACT same deal doubles the match total
  // (12 -> 24) and shows up in `homeruns` — isolates the bonus itself from everything
  // else computeResults does.
  let foundSweep = false;
  for (let i = 0; i < 4000 && !foundSweep; i++) {
    const { hands, boards } = G.dealHand(['alice', 'bob'], 7);
    const split = (cards) => ({ one: [cards[0]], two: cards.slice(1, 3), four: cards.slice(3, 7) });
    const players = [
      { id: 'alice', name: 'Alice', assignment: split(hands.alice) },
      { id: 'bob', name: 'Bob', assignment: split(hands.bob) }
    ];
    const plain = G.computeResults(players, boards, false);
    if (Math.abs(plain.pointsByPlayer.alice) === 12) {
      foundSweep = true;
      const withBonus = G.computeResults(players, boards, true);
      const winner = plain.pointsByPlayer.alice > 0 ? 'alice' : 'bob';
      const loser = winner === 'alice' ? 'bob' : 'alice';
      assert(withBonus.homeruns.length === 1 && withBonus.homeruns[0].winner === winner, 'a clean 6-for-6 sweep is reported in `homeruns` with the correct winner');
      assert(withBonus.pointsByPlayer[winner] === 24, 'homerun bonus doubles the sweeping player\'s match total to 24');
      assert(withBonus.pointsByPlayer[loser] === -24, 'homerun bonus doubles the swept player\'s match total to -24');
    }
  }
  assert(foundSweep, 'found at least one clean 6-for-6 sweep within 4000 random heads-up deals to test the homerun bonus against');
}

// --- computeLiveSnapshot: mid-sweat partial-board scoring ---
{
  const boardAFull = ['2c', '5h', '9s', 'Jd', '2d'];
  const boardBFull = ['3c', '6h', 'Ts', 'Kd', '7d'];
  const players = [
    { id: 'alice', name: 'Alice', assignment: { one: ['As'], two: ['Kh', 'Qc'], four: ['Jh', 'Th', '9h', '8h'] } },
    { id: 'bob', name: 'Bob', assignment: { one: ['2h'], two: ['3d', '4c'], four: ['5s', '6s', '7c', '8c'] } }
  ];

  // At the flop (3 known cards per board): the 1-card hand needs a pool of >=5 (1 hole +
  // >=4 board) and can't make anything yet off just 3 board cards, but the 2-card hand
  // (2+3=5) and the 4-card PLO hand (always exactly 3 board cards) can.
  const flopA = boardAFull.slice(0, 3);
  const flopB = boardBFull.slice(0, 3);
  const atFlop = G.computeLiveSnapshot(players, [flopA, flopB], false);
  assert(G.canEvaluateCategory('one', players[0].assignment.one, flopA) === false, 'canEvaluateCategory: the 1-card hand is NOT evaluable against a 3-card (flop-only) board');
  assert(G.canEvaluateCategory('two', players[0].assignment.two, flopA) === true, 'canEvaluateCategory: the 2-card hand IS evaluable against a 3-card board (2+3=5)');
  assert(G.canEvaluateCategory('four', players[0].assignment.four, flopA) === true, 'canEvaluateCategory: the 4-card PLO hand is evaluable from the flop onward (always exactly 3 board cards)');
  assert(atFlop.evals.alice.one[0] === null && atFlop.evals.bob.one[0] === null, 'computeLiveSnapshot: the 1-card hand comes back null (pending) for both players at the flop');
  assert(atFlop.evals.alice.two[0] !== null && atFlop.evals.alice.four[0] !== null, 'computeLiveSnapshot: the 2-card and 4-card hands are already evaluated at the flop');
  assert(atFlop.comparisons.every((c) => c.category !== 'one'), 'computeLiveSnapshot: no "one" category comparisons are recorded yet at the flop (nothing pending gets scored)');
  assert(atFlop.comparisons.some((c) => c.category === 'two' && c.boardIndex === 0), 'computeLiveSnapshot: the evaluable 2-card/flop comparison IS recorded');

  // At the turn (4 known cards per board): the 1-card hand becomes evaluable (1+4=5).
  const turnA = boardAFull.slice(0, 4);
  const turnB = boardBFull.slice(0, 4);
  const atTurn = G.computeLiveSnapshot(players, [turnA, turnB], false);
  assert(atTurn.evals.alice.one[0] !== null, 'computeLiveSnapshot: the 1-card hand becomes evaluable once the board reaches 4 known cards (the turn)');
  assert(atTurn.comparisons.some((c) => c.category === 'one'), 'computeLiveSnapshot: "one" category comparisons now appear at the turn');

  // Once every board is fully dealt out, computeLiveSnapshot must agree EXACTLY with
  // computeResults — it's a strict generalization, not a different rule set once nothing
  // is pending.
  const full = G.computeLiveSnapshot(players, [boardAFull, boardBFull], false);
  const direct = G.computeResults(players, [boardAFull, boardBFull], false);
  assert(JSON.stringify(full.pointsByPlayer) === JSON.stringify(direct.pointsByPlayer), 'computeLiveSnapshot matches computeResults\' pointsByPlayer exactly once both boards are fully known');
  assert(full.comparisons.length === direct.comparisons.length && full.comparisons.length === 6, 'computeLiveSnapshot produces the same 6 comparisons as computeResults once nothing is pending');

  // Homerun guard: a pairing can't be credited a homerun off of only the comparisons that
  // happen to be decided so far — it must wait for all 6 to actually be known. Craft a
  // heads-up deal with a clean 6-for-6 sweep (same technique as the computeResults test
  // above), confirm the FULL board awards it, then confirm the FLOP-only computeLiveSnapshot
  // for that exact same deal does NOT (since "one" category is still pending at the flop).
  let found = false;
  for (let i = 0; i < 4000 && !found; i++) {
    const { hands, boards } = G.dealHand(['alice', 'bob'], 7);
    const split = (cards) => ({ one: [cards[0]], two: cards.slice(1, 3), four: cards.slice(3, 7) });
    const sweepPlayers = [
      { id: 'alice', name: 'Alice', assignment: split(hands.alice) },
      { id: 'bob', name: 'Bob', assignment: split(hands.bob) }
    ];
    const plain = G.computeResults(sweepPlayers, boards, false);
    if (Math.abs(plain.pointsByPlayer.alice) === 12) {
      found = true;
      const fullSnapshot = G.computeLiveSnapshot(sweepPlayers, boards, true);
      assert(fullSnapshot.homeruns.length === 1, 'computeLiveSnapshot credits the homerun once every board is fully known, same as computeResults');
      const partialSnapshot = G.computeLiveSnapshot(sweepPlayers, [boards[0].slice(0, 3), boards[1].slice(0, 3)], true);
      assert(partialSnapshot.homeruns.length === 0, 'computeLiveSnapshot does NOT credit a homerun at the flop for the same deal, since the 1-card comparisons are still pending');
    }
  }
  assert(found, 'found at least one clean 6-for-6 sweep within 4000 random deals to test the live-snapshot homerun guard against');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
