# Sweat Room

An app for setting up a Taiwanese Poker hand for 2-4 players and then sweating it out, card
by card, with a live side-by-side win% table and a baccarat/ClubGG-style drag-to-squeeze
reveal for rivers that can really swing the hand. There's no "Practice" mode here on
purpose — this tool is only about building one hand and sweating the result. It can be
played two ways: **Solo** (one browser arranges every seat, hot-seat style) or
**Multiplayer** (create a room, send the link, and everyone arranges their own hand
privately on their own device before sweating the board together).

The look and the arranging interaction deliberately match the sibling Taiwanese Poker
project (same light felt-and-gold theme, 4-color deck, click-card-then-click-slot arranger),
so switching between the two feels like one app family — Sweat Room just adds the
you-arrange-both-sides setup, the automatically-paced card-by-card reveal with live
side-by-side equity, and the river swing/outs/squeeze mechanic on top.

Nothing about the reveal is clicked through any more: once everyone's hand is arranged, the
flop, both turns, and both rivers each reveal themselves on their own clock, with a
deliberate pause at every stage for suspense. The *only* thing a person still ever does by
hand is the squeeze — and only when a river actually turns out to swing the hand.

## Running it

```
node server.js
```

Then open `http://localhost:3400/` (set `PORT` to use a different port). The static site has
no dependencies and no build step; the server itself is still a plain Node `http` server with
no third-party packages — the multiplayer room API below is just a few extra JSON routes on
the same server, backed by an in-memory room store (`lib/rooms.js`). For someone else to join
a room over the internet (not just on your LAN), the machine running `node server.js` needs
to actually be reachable at whatever address you share — this repo doesn't include any
tunneling/hosting setup, so pick a host (or a tool like `ngrok`) that gets you a public URL
pointing at this server if you want to play with people who aren't on your network.

## Solo vs. Multiplayer

The very first screen asks which one you want:

- **Solo** — unchanged from before: one browser deals and arranges every seat, then sweats
  the result on that same screen. Good for building a specific hand to study, or for a group
  physically looking at one screen together.
- **Multiplayer** — create a room (pick 2-4 players, your name, and whether the Homerun bonus
  is on) and you'll get a room code and a shareable link (`/?room=ABCDE`). Anyone who opens
  that link lands straight on a "join this room" form. Once every seat is filled, the host
  deals, and **each player then arranges only their own 7 cards, privately** — nobody,
  including the host, can see another seat's split until every seat has clicked **I'm Ready**.
  The instant the last player readies up, every hand is "tabled" (shown to the whole table,
  like a real sweat) and **the server itself starts pacing the board reveal** — flop, both
  turns, both rivers — on its own clock, identically for every connected screen. Nobody
  clicks anything to make that happen; the only time a person acts is when a river turns out
  to be a swing spot, in which case the **host** (and only the host) physically completes the
  squeeze, and everyone else watches it happen live. Reloading the page mid-game resumes your
  seat automatically (your room + seat are remembered in `localStorage`).

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

## Setting up a hand (Solo)

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
— the sweat screen just controls when each card gets shown, and it controls that itself:
there is nothing to click. The reveal always goes in this order, each stage sitting
revealed for a couple of seconds before the next one starts, for a bit of dramatic pacing:

1. **Both flops together** (3 cards on each board, revealed simultaneously)
2. **Turn, Board A**
3. **Turn, Board B**
4. **River, Board A**
5. **River, Board B**

After every single reveal, the results view recomputes live into a **side-by-side compare
table** — one column per player, one row per category × board (6 rows: 1-card/2-card/4-card
PLO, each against Board A and Board B). Every cell shows that player's cards for that hand
(with the ones used in their current best hand highlighted once resolved), their current
category name, a running point total for that cell summed across every opponent at the
table, and — this is the useful part — a **live win% badge for that specific cell**, even
before the hand can be named. The 1-card hand's category can't actually be determined until
the turn (a single card plus 4 known board cards isn't enough for a 5-card hand yet), but its
win% is still meaningful at the flop already, so the badge shows a real, live-updating
percentage there labeled "pending…" right next to it, instead of nothing at all. Once both
rivers are in, a sorted scoreboard and a full comparison log (every one of the
3×2×(pairs of players) comparisons) appear underneath.

### How this differs in Multiplayer

The arranging step above is Solo-only (one browser arranging every seat on tabs). In a
Multiplayer room, each player gets their own single-hand arranger screen (no tabs — just
your own cards). Once everyone's ready, the **server** paces the reveal for every connected
screen identically — nobody, host included, clicks anything to make the flop or a turn or a
plain (non-swing) river happen. The server (not any one browser) is the authority on the
deck, the boards, and how far the reveal has gotten — in particular, an unrevealed card's
value is never sent to any browser at all (not even the host's), so there's nothing to find
by poking at network traffic before it's actually revealed. The one exception: if a river
turns out to be a swing spot, the server pauses there and waits — indefinitely — for the
**host**, and only the host, to physically complete the squeeze (see below); everyone else's
screen shows a "&lt;host&gt; is squeezing…" message and watches the outs panel and the
eventual reveal mirror over live once the host finishes it.

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

### Outs and the squeeze

Right before each river is revealed, Sweat Room checks every possible value that card could
take and computes each player's expected points for that specific value, compared against
the average across all of them. If any player's expected points would swing by 5 or more
(the default threshold) depending on the river, that river is treated as a swing spot:

- An **outs panel** appears, listing which specific cards would swing it and for whom.
- The river stops revealing itself automatically and instead waits for a **squeeze** —
  baccarat/ClubGG style. A small face-down "Tap to squeeze" trigger appears; tapping it opens
  a bigger card front-and-center. **Drag it** (not hold it — the reveal tracks how far you've
  dragged, not how long) and it physically bends open: partway through, the card goes
  edge-on, like you're peeking at its side before committing to look; keep dragging and the
  true face swings into view. Release before you've dragged far enough and it springs back
  face-down, unrevealed. Drag far enough (or release past that point) and it locks in
  revealed. In Multiplayer, only the host ever does this — everyone else just watches it
  happen on their own screen in real time once the host finishes.

If a river *isn't* a swing spot, there's no squeeze at all — it just reveals itself on the
same automatic clock as everything else, no ceremony needed when nothing much is riding on
it.

The actual card you reveal was already dealt the moment you clicked "Deal Hands" — squeezing
doesn't draw a new random card, it just controls when you see the one that was already
there. The suspense is real; the deck isn't being tampered with to make it dramatic.

## Project layout

```
lib/poker.js      — the 5-card hand evaluator (shared with the sibling Taiwanese Poker app)
lib/game.js       — dealing, split validation, and the 1/2/4 × 2-board scoring engine
lib/equity.js     — live win%/expected-points equity, and the river swing/outs check
lib/rooms.js      — multiplayer: in-memory room store + the join/deal/submit/reveal flow
public/           — the actual website (index.html, style.css, client.js)
server.js         — static file server + the /api/rooms/* multiplayer JSON API
tests/            — Node test suites (see below)
```

`lib/poker.js`, `lib/game.js`, and `lib/equity.js` are written UMD-style, so the exact same
code runs under `node tests/*.test.js` and as plain `<script>` tags in the browser — no
separate client and server implementations to keep in sync. `lib/rooms.js` is Node-only (it's
the multiplayer server's private state, never shipped to the browser) and isn't UMD-wrapped.

## Tests

```
node tests/game.test.js
node tests/equity.test.js
node tests/rooms_api.test.js
npm install           # only needed once, for the jsdom-based UI tests below
node tests/ui_sim.test.js
node tests/multiplayer_ui.test.js
```

`game.test.js`, `equity.test.js`, and `rooms_api.test.js` are dependency-free (the last one
drives the real multiplayer server over real HTTP with Node's built-in `fetch`, as two
separate simulated players, checking that hidden hands actually stay hidden over the wire and
that host-only actions are rejected for everyone else). `ui_sim.test.js` and
`multiplayer_ui.test.js` are the two that need `npm install` first, since they drive a real
DOM via `jsdom` — this environment's browser-automation tool turned out to have its outbound
networking blocked entirely (even plain navigation to `localhost` or `example.com` failed), so
jsdom is what actually exercises the UI code end-to-end here.

`ui_sim.test.js` covers the Solo flow: mode screen → setup → arrange → sweat (automatic
flop/turn/river pacing, with no buttons to click) → showdown, including both the plain
auto-reveal and drag-squeeze paths, and checks that the compare table's win% badges show up
even on pending cells. Both suites speed up the normally multi-second reveal pacing via a
`SWEAT_ROOM_FAST_TIMERS=1` env var (server-side, `lib/rooms.js`) and a matching
`window.__SWEAT_ROOM_FAST_TIMERS__` flag (client-side), so a full hand takes milliseconds
instead of real seconds to verify. `multiplayer_ui.test.js` is the sterner test — it spins up
the real server and drives **two independent `jsdom` windows** (host + guest) against it
over real HTTP, exactly like two different browsers on two different devices: creating a
room, joining by code, dealing, each window arranging only its own hand, confirming the two
hands are actually different and hidden from each other, readying up, and then watching the
server's own automatic reveal (including an outs/squeeze river that only the host completes)
mirror live onto the guest's screen with identical board cards and identical final scores.
