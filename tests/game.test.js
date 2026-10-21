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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
