# Sweat Room

A standalone hot-seat app for setting up a Taiwanese Poker hand for 2-4 players and then
sweating it out, card by card, with live equity and a baccarat-style peel for rivers that
can really swing the hand. There's no "Practice" mode here on purpose — this tool is only
about building one hand and sweating the result.

The look and the arranging/results interactions deliberately match the sibling Taiwanese
Poker project (same light felt-and-gold theme, 4-color deck, click-card-then-click-slot
arranger, and per-player/per-category/per-board scoreboard), so switching between the two
feels like one app family — Sweat Room just adds the you-arrange-both-sides setup, the
staged card-by-card reveal with live equity, and the river swing/outs/peel mechanic on top.

## Running it

```
node server.js
```

Then open `http://localhost:3400/` (set `PORT` to use a different port). No dependencies,
no build step — just a zero-dependency Node `http` server and a handful of plain files.

## The rules

Each player gets 7 cards, split into three hands:

- a **1-card** hand
- a **2-card** hand
- a **4-card PLO** hand (you use exactly 2 of your 4 cards, plus exactly 3 of the 5 board
  cards — standard Omaha construction)

There are two independent 5-card boards, Board A and Board B. Every player's three hands
are compared against both boards, so a full hand produces 3 categories × 2 boards = 6
comparisons per pair of players. Each comparison is worth points — 1 for the 1-card hand,
2 for the 2-card hand, 3 for the 4-card PLO hand — awarded zero-sum (winner gains, loser
loses the same amount; ties award nothing). With the optional **Homerun bonus** turned on,
sweeping all 6 comparisons against one specific opponent (no ties anywhere) doubles the
entire match total for that pairing (12 points swapped becomes 24).

## Setting up a hand

1. Pick 2, 3, or 4 players and name them.
2. Click **Deal Hands** — everyone gets 7 random cards, and both boards are dealt in full
   immediately (face down). You arrange every player's hand yourself, one tab at a time,
   using the same click-a-card-then-click-a-box interaction as the sibling Taiwanese Poker
   project: click a card in your tray to select it (it highlights), then click the 1-Card,
   2-Card, or 4-Card PLO box to drop it there — or Cmd/Ctrl+click a tray card to send it
   straight to the first open slot. Click a placed card to send it back to the tray. A
   sort control (Dealt / Rank / Suit) above the tray remembers your preference between
   hands. A player's tab gets a checkmark once their split is complete and legal.
3. Once everyone's valid, **Sweat It Out** unlocks.

## The sweat

Both boards are already fully dealt behind the scenes the moment you clicked "Deal Hands"
— the sweat screen just controls when each card gets shown. The reveal always goes in this
order:

1. **Both flops together** (3 cards on each board, revealed simultaneously)
2. **Turn, Board A**
3. **Turn, Board B**
4. **River, Board A**
5. **River, Board B**

After every single reveal, the results view recomputes live, in the same multiway-friendly
scoreboard format as the sibling Taiwanese Poker project: each player gets a box showing
their hole cards grouped by hand, and for each of the 3 categories × 2 boards, a cell
showing their current best-hand category (with the cards it's using highlighted) and a
running point total for that cell, summed across every opponent at the table — so it reads
correctly whether it's heads-up or a full 4-player table. A cell that can't be evaluated yet
(the 1-card hand needs the turn, not just the flop, to have enough cards to make a 5-card
hand) shows "needs more board cards…" until it's resolved. Underneath each player's total,
a secondary line shows the probabilistic side of things — win% and projected finish — fading
away once the hand is fully determined. Once both rivers are in, a sorted scoreboard and a
full comparison log (every one of the 3×2×(pairs of players) comparisons) appear underneath.

### Exact math where it's cheap, sampling where it isn't

`lib/equity.js` enumerates every possible way the remaining unseen cards could land when
that's computationally cheap, and falls back to Monte Carlo sampling when it isn't — the
same philosophy as the sibling Taiwanese Poker project's Practice Mode EV engine. The
"cheap enough" line isn't a fixed card-combination count: evaluating one hypothetical board
costs more with more players at the table, so the exact-vs-sampled threshold scales down as
player count goes up, keeping the total work (and the wait) roughly constant instead of
letting a 4-player hand take 3-4× longer than a 2-player one for the same reveal. Either
way, the work happens in small batches with a yield back to the browser between each one,
so the UI never freezes — you'll just see a brief "Working out the odds… NN%" note.

### The fixed reveal order isn't arbitrary

Flops together, then Turn A, Turn B, River A, River B — always in that order — is what
keeps the "is this river about to swing the hand?" check cheap. By the time either river is
about to be revealed, there's at most one *other* unknown card left in play (the other
board's own pending river, if it hasn't been shown yet), so checking every possible value
of the pending river only ever needs to additionally average over one more unknown card at
most, never two.

### Outs and the peel

Right before each river is revealed, Sweat Room checks every possible value that card could
take and computes each player's expected points for that specific value, compared against
the average across all of them. If any player's expected points would swing by 5 or more
(the default threshold) depending on the river, that river is treated as a swing spot:

- An **outs panel** appears, listing which specific cards would swing it and for whom.
- The river is no longer a simple flip — it becomes a **hold-to-peel card**. Press and hold
  to slowly lift the corner and reveal it top-to-bottom over about a second and a half.
  Release early and it snaps back face-down, unrevealed. Hold it all the way and it locks in
  revealed.

If a river *isn't* a swing spot, it's just a plain click-to-reveal card — no ceremony needed
when nothing much is riding on it.

The actual card you reveal was already dealt the moment you clicked "Deal Hands" — peeling
doesn't draw a new random card, it just controls when you see the one that was already
there. The suspense is real; the deck isn't being tampered with to make it dramatic.

## Project layout

```
lib/poker.js      — the 5-card hand evaluator (shared with the sibling Taiwanese Poker app)
lib/game.js       — dealing, split validation, and the 1/2/4 × 2-board scoring engine
lib/equity.js     — live win%/expected-points equity, and the river swing/outs check
public/           — the actual website (index.html, style.css, client.js)
server.js         — zero-dependency static file server
tests/            — Node test suites (game logic, equity math, and a jsdom UI simulation)
```

All three `lib/*.js` files are written UMD-style, so the exact same code runs under
`node tests/*.test.js` and as plain `<script>` tags in the browser — no separate client and
server implementations to keep in sync.

## Tests

```
node tests/game.test.js
node tests/equity.test.js
npm install           # only needed once, for ui_sim.test.js's jsdom dependency
node tests/ui_sim.test.js
```

(`game.test.js` and `equity.test.js` are dependency-free; `ui_sim.test.js` is the only one
that needs `npm install` first, since it drives a real DOM via `jsdom`.)

`ui_sim.test.js` drives the actual `public/index.html` + `client.js` through a full
setup → arrange → sweat → showdown flow (including both the plain-reveal and the
hold-to-peel paths) against a real headless DOM (via `jsdom`), rather than a browser —
this environment's browser-automation tool turned out to have its outbound networking
blocked entirely (even plain navigation to `localhost` or `example.com` failed), so the
jsdom-based simulation is what actually exercises the UI code end-to-end here.
