// Sanity + correctness checks for lib/equity.js (the live-equity and river-swing/outs
// engine). Run with: node tests/equity.test.js
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'lib', 'poker.js'));
const G = require(path.join(__dirname, '..', 'lib', 'game.js'));
const E = require(path.join(__dirname, '..', 'lib', 'equity.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok:', msg); }
}

async function main() {
  // --- small helpers ---
  assert(E.permCount(5, 0) === 1, 'permCount(n, 0) is 1 (one way to draw nothing)');
  assert(E.permCount(5, 2) === 20, 'permCount(5, 2) === 5*4 === 20');
  assert(E.permCount(3, 5) === 0, 'permCount with k > n is 0 (not enough cards)');
  {
    const perms = E.enumerateExact(['a', 'b', 'c'], 2);
    assert(perms.length === 6, 'enumerateExact(3 items, k=2) produces all 6 ordered pairs');
    assert(perms.every((p) => p[0] !== p[1]), 'enumerateExact never repeats a card within one draw');
  }
  {
    const pool = P.freshDeck();
    const drawn = E.drawRandom(pool, 4);
    assert(drawn.length === 4 && new Set(drawn).size === 4, 'drawRandom returns the requested count with no duplicates');
    assert(drawn.every((c) => pool.includes(c)), 'drawRandom only returns cards that were actually in the pool');
  }
  {
    const unseen = E.unseenDeck(['As', 'Kd']);
    assert(unseen.length === 50 && !unseen.includes('As') && !unseen.includes('Kd'), 'unseenDeck excludes exactly the known cards');
  }

  // --- computeStageEquity: fully-determined case (needed === 0) ---
  // Both boards complete, nothing left to guess — equity collapses to the single actual
  // outcome, and it must exactly match a direct computeResults call.
  {
    const boardA = ['2c', '5h', '9s', 'Jd', '2d'];
    const boardB = ['3c', '6h', 'Ts', 'Kd', '7d'];
    const players = [
      { id: 'alice', name: 'Alice', assignment: { one: ['As'], two: ['Kd', 'Qc'], four: ['Jh', 'Ts', '9d', '8c'] } },
      { id: 'bob', name: 'Bob', assignment: { one: ['2h'], two: ['3d', '4c'], four: ['5s', '6h', '7c', '8d'] } }
    ];
    const direct = G.computeResults(players, [boardA, boardB], false);
    const eq = await E.computeStageEquity({ players, boardAKnown: boardA, boardBKnown: boardB, homerunMode: false });
    assert(eq.mode === 'determined' && eq.trialsUsed === 1, 'computeStageEquity recognizes a fully-known board needs zero sampling');
    assert(eq.expectedPoints.alice === direct.pointsByPlayer.alice, 'determined-mode expected points match a direct computeResults call exactly');
    const winner = direct.pointsByPlayer.alice > direct.pointsByPlayer.bob ? 'alice' : (direct.pointsByPlayer.bob > direct.pointsByPlayer.alice ? 'bob' : null);
    if (winner) assert(eq.winPct[winner] === 1 && eq.winPct[winner === 'alice' ? 'bob' : 'alice'] === 0, 'determined-mode win% is 100% for whoever actually has more points');
  }

  // --- computeStageEquity: small exact case cross-checked against brute force ---
  // One unknown card total (needA=0, needB=1): every candidate is cheap to enumerate by
  // hand, so we can verify the engine's "exact" path against an independent brute-force
  // average computed right here in the test.
  {
    const boardAFull = ['2c', '5h', '9s', 'Jd', '2d'];
    const boardBPartial = ['3c', '6h', 'Ts', 'Kd']; // missing the river
    const players = [
      { id: 'alice', name: 'Alice', assignment: { one: ['As'], two: ['Kh', 'Qc'], four: ['Jh', 'Th', '9h', '8h'] } },
      { id: 'bob', name: 'Bob', assignment: { one: ['2h'], two: ['3d', '4c'], four: ['5s', '6s', '7c', '8c'] } }
    ];
    const eq = await E.computeStageEquity({ players, boardAKnown: boardAFull, boardBKnown: boardBPartial, homerunMode: false });
    assert(eq.mode === 'exact', 'a single unknown card stays well under the exact-enumeration threshold');

    const allKnown = [...players[0].assignment.one, ...players[0].assignment.two, ...players[0].assignment.four,
      ...players[1].assignment.one, ...players[1].assignment.two, ...players[1].assignment.four,
      ...boardAFull, ...boardBPartial];
    const pool = E.unseenDeck(allKnown);
    let sumAlice = 0;
    pool.forEach((card) => {
      const r = G.computeResults(players, [boardAFull, boardBPartial.concat([card])], false);
      sumAlice += r.pointsByPlayer.alice;
    });
    const expected = sumAlice / pool.length;
    assert(Math.abs(eq.expectedPoints.alice - expected) < 1e-9, `exact-mode expected points match an independent brute-force average (engine: ${eq.expectedPoints.alice}, brute force: ${expected})`);
  }

  // --- computeStageEquity: sampled mode still lands close to the exact answer ---
  // Force the Monte Carlo path with a tiny maxExact, and check it converges near the
  // true exact answer (computed with a generous maxExact) within a loose tolerance.
  {
    const boardAKnown = ['2c', '5h', '9s']; // flop only, 2 unknown (turn+river)
    const boardBKnown = ['3c', '6h', 'Ts', 'Kd']; // turn known, 1 unknown (river)
    const players = [
      { id: 'alice', name: 'Alice', assignment: { one: ['As'], two: ['Kh', 'Qc'], four: ['Jh', 'Th', '9h', '8h'] } },
      { id: 'bob', name: 'Bob', assignment: { one: ['2h'], two: ['3d', '4c'], four: ['5s', '6s', '7c', '8c'] } }
    ];
    const exact = await E.computeStageEquity({ players, boardAKnown, boardBKnown, homerunMode: false, maxExact: 100000 });
    assert(exact.mode === 'exact', 'this 3-unknown-card case is still small enough to enumerate exactly for the reference answer');

    const sampled = await E.computeStageEquity({ players, boardAKnown, boardBKnown, homerunMode: false, maxExact: 1, mcTrials: 4000 });
    assert(sampled.mode === 'sampled', 'a maxExact of 1 forces the Monte Carlo path even though exact enumeration was feasible');
    const diff = Math.abs(sampled.expectedPoints.alice - exact.expectedPoints.alice);
    assert(diff < 0.5, `Monte Carlo expected points land within 0.5 of the exact answer (exact: ${exact.expectedPoints.alice.toFixed(3)}, sampled: ${sampled.expectedPoints.alice.toFixed(3)}, diff: ${diff.toFixed(3)})`);
    const winDiff = Math.abs(sampled.winPct.alice - exact.winPct.alice);
    assert(winDiff < 0.08, `Monte Carlo win% lands within 8 points of the exact answer (exact: ${(exact.winPct.alice * 100).toFixed(1)}%, sampled: ${(sampled.winPct.alice * 100).toFixed(1)}%)`);
  }

  // --- computeStageEquity: win% and category win% always sum to 1 across players ---
  {
    const boardAKnown = ['2c', '5h', '9s', 'Jd'];
    const boardBKnown = ['3c', '6h', 'Ts', 'Kd', '7d'];
    const players = [
      { id: 'p1', name: 'P1', assignment: { one: ['As'], two: ['Kh', 'Qc'], four: ['Jh', 'Th', '9h', '8h'] } },
      { id: 'p2', name: 'P2', assignment: { one: ['2h'], two: ['3d', '4c'], four: ['5s', '6s', '7c', '8c'] } },
      { id: 'p3', name: 'P3', assignment: { one: ['3h'], two: ['4d', '5c'], four: ['6c', '7s', '9c', 'Tc'] } }
    ];
    const eq = await E.computeStageEquity({ players, boardAKnown, boardBKnown, homerunMode: false });
    const winSum = players.reduce((s, p) => s + eq.winPct[p.id], 0);
    assert(Math.abs(winSum - 1) < 1e-9, `win% across all 3 players sums to 1 (got ${winSum})`);
    const catSum = players.reduce((s, p) => s + eq.categoryWinPct[p.id]['A.one'], 0);
    assert(Math.abs(catSum - 1) < 1e-9, `per-category win% across all 3 players sums to 1 for a given board+category (got ${catSum})`);
  }

  // --- computeRiverSwing: a crafted scenario that MUST clear the swing threshold ---
  // One/two categories are built rank-symmetric between the two players (same ranks,
  // different suits, flushes structurally impossible) so they tie no matter what the
  // river is — verified exhaustively below, not just assumed. Four-on-boardB is the
  // deliberate exception: Bob's pair of kings currently beats Alice's pair of queens
  // outright — but if the river is the 3rd or 4th queen, Alice's OTHER two hole cards
  // for that category (a PLO hand picks the best 2-of-4 hole cards) let her upgrade to
  // TRIPS queens, which beats any pair regardless of rank. The "junk" hole cards for
  // both players' four-category (Jh/2s for Alice, Js/2h for Bob) were deliberately
  // chosen far from every board rank (3,5,7,9 on boardB; the river itself) so that no
  // river value can build a straight or pair into something that changes who wins the
  // four-category except via that one queen-trips mechanism — confirmed by brute-forcing
  // every possible river value below rather than trusting hand-reasoning alone (an
  // earlier, less careful construction silently let a river 6 build Bob a gutshot
  // straight, which is exactly the kind of interaction this exhaustive check catches).
  {
    const boardA = ['2c', '4d', '6s', '8h', 'Tc'];
    const boardBBeforeRiver = ['3d', '5h', '7s', '9c'];
    const players = [
      { id: 'alice', name: 'Alice', assignment: { one: ['9h'], two: ['Jc', 'Th'], four: ['Qc', 'Qd', 'Jh', '2s'] } },
      { id: 'bob', name: 'Bob', assignment: { one: ['9s'], two: ['Jd', 'Ts'], four: ['Kc', 'Kd', 'Js', '2h'] } }
    ];
    const allCards = [boardA, boardBBeforeRiver, players[0].assignment.one, players[0].assignment.two, players[0].assignment.four,
      players[1].assignment.one, players[1].assignment.two, players[1].assignment.four].flat();
    assert(new Set(allCards).size === allCards.length, 'swing-scenario setup: all 23 cards used so far are distinct (sanity check on the hand-crafted construction)');

    // Brute-force every possible river value directly through computeResults (independent
    // of computeRiverSwing) to establish ground truth: the four-category on boardB must
    // go to Bob for every river except the two remaining queens, and one/two must tie on
    // every single river, with no exceptions anywhere in the pool.
    const unseen = E.unseenDeck(allCards);
    const expectedFlips = [];
    for (const card of unseen) {
      const boardB = boardBBeforeRiver.concat([card]);
      const r = G.computeResults(players, [boardA, boardB], false);
      const oneW = r.comparisons.find((c) => c.boardIndex === 1 && c.category === 'one').winner;
      const twoW = r.comparisons.find((c) => c.boardIndex === 1 && c.category === 'two').winner;
      assert(oneW === null, `one-category on boardB ties for river ${card} (rank-symmetric hole cards, no flush possible)`);
      assert(twoW === null, `two-category on boardB ties for river ${card} (rank-symmetric hole cards, no flush possible)`);
      const fourW = r.comparisons.find((c) => c.boardIndex === 1 && c.category === 'four').winner;
      if (fourW === 'alice') expectedFlips.push(card);
    }
    assert(expectedFlips.length === 2 && expectedFlips.includes('Qs') && expectedFlips.includes('Qh'),
      `exactly the two remaining queens flip the four-category on boardB to Alice, got [${expectedFlips.join(', ')}]`);

    const swing = await E.computeRiverSwing({ players, boards: [boardA, boardBBeforeRiver], pendingBoardIndex: 1, homerunMode: false });
    const queenOuts = ['Qs', 'Qh'].map((c) => swing.candidates.find((cand) => cand.card === c));
    queenOuts.forEach((out, i) => {
      const card = ['Qs', 'Qh'][i];
      assert(!!out, `${card} is among the candidate river cards considered`);
      assert(out.isSwing === true, `${card} (completing Alice's trip queens, beating Bob's pair of kings outright) is correctly flagged as a swing card`);
      assert(out.beneficiary === 'alice', `${card} correctly benefits Alice, not Bob`);
    });
    // The magnitude isn't a clean +6: baseline averages over the WHOLE pool (27 rivers
    // that keep Bob's -6 swept total vs. 2 queens that flip it to 0), so the queen delta
    // is 0 - mean(27*-6 + 2*0)/29 ≈ +5.586, not +6. Compute the expected value the same
    // way computeRiverSwing does (independent of its internals) rather than hardcoding a
    // number that only holds for a different-sized pool.
    const total = unseen.length;
    const nonFlip = total - expectedFlips.length;
    const baselineAlice = (nonFlip * -6 + expectedFlips.length * 0) / total;
    const expectedMagnitude = 0 - baselineAlice;
    queenOuts.forEach((out, i) => {
      const card = ['Qs', 'Qh'][i];
      assert(Math.abs(out.magnitude - expectedMagnitude) < 1e-9,
        `${card} swings Alice's expected points by ${expectedMagnitude.toFixed(6)} (independently derived from the brute-force sweep), got ${out.magnitude}`);
    });
    assert(swing.hasSwing === true, 'computeRiverSwing reports hasSwing: true overall given the queen outs');
  }

  // --- computeRiverSwing: a fully rank-symmetric scenario can NEVER swing ---
  // Both players hold the exact same rank multiset in every category (suits only
  // permuted) against flush-impossible boards — every comparison ties no matter what the
  // river turns out to be, so this is a mathematical guarantee, not a probabilistic hope:
  // hasSwing must be false and every delta must be exactly 0.
  {
    const boardA = ['2c', '4d', '6s', '8h', 'Tc'];
    const boardBBeforeRiver = ['3d', '5h', '7s', '9c'];
    const players = [
      { id: 'alice', name: 'Alice', assignment: { one: ['9h'], two: ['Jc', 'Th'], four: ['Kc', 'Kd', '2h', '3s'] } },
      { id: 'bob', name: 'Bob', assignment: { one: ['9s'], two: ['Jd', 'Ts'], four: ['Ks', 'Kh', '2d', '3c'] } }
    ];
    const allCards = [boardA, boardBBeforeRiver, players[0].assignment.one, players[0].assignment.two, players[0].assignment.four,
      players[1].assignment.one, players[1].assignment.two, players[1].assignment.four].flat();
    assert(new Set(allCards).size === allCards.length, 'no-swing-scenario setup: all 22 cards used so far are distinct');

    const swing = await E.computeRiverSwing({ players, boards: [boardA, boardBBeforeRiver], pendingBoardIndex: 1, homerunMode: false });
    assert(swing.hasSwing === false, 'a fully rank-symmetric, flush-impossible hand never swings, for any river card');
    assert(swing.outs.length === 0, 'no outs are listed when every comparison ties regardless of the river');
    const allZero = swing.candidates.every((c) => Math.abs(c.delta.alice) < 1e-9 && Math.abs(c.delta.bob) < 1e-9);
    assert(allZero, 'every single candidate river card produces an exact zero delta for both players, not just an average of zero');
  }

  // --- computeRiverSwing: the "already fully known" other board (needOther === 0) path ---
  {
    const boardAKnownFull = ['2c', '5h', '9s', 'Jd', '7d']; // fully known, this is NOT the pending board
    const boardBBeforeRiver = ['3c', '6h', 'Ts', 'Kd'];
    const players = [
      { id: 'alice', name: 'Alice', assignment: { one: ['As'], two: ['Kh', 'Qc'], four: ['2h', '3d', '4s', '5c'] } },
      { id: 'bob', name: 'Bob', assignment: { one: ['2d'], two: ['3h', '4c'], four: ['6s', '7c', '8d', '9c'] } }
    ];
    const swing = await E.computeRiverSwing({ players, boards: [boardAKnownFull, boardBBeforeRiver], pendingBoardIndex: 1, homerunMode: false });
    // Cross-check one specific candidate directly against a plain computeResults call.
    const sampleCard = swing.candidates[0].card;
    const direct = G.computeResults(players, [boardAKnownFull, boardBBeforeRiver.concat([sampleCard])], false);
    assert(swing.candidates[0].expected.alice === direct.pointsByPlayer.alice, 'when the other board is already fully known, each candidate\'s expected points is just the exact single outcome, matching computeResults directly');
  }

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
