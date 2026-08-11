# Firebase Centaur Interface

Centaurs play Team Snek **directly through Firebase**. A centaur signs in to
Firebase Auth as a first-class *centaur principal*, listens to game documents
in Firestore, and submits moves by writing documents — no inbound HTTP
endpoint required. Humans never play: they configure games, own centaurs, and
spectate.

## What the interface gives you

- **One centaur identity, many snakes.** A centaur added to a game controls a
  whole team of `snakesPerTeam` snakes. It signs in once and acts for every
  snake mapped to it, each with its own staged move.
- **Move staging.** A centaur may stage a move for a snake as many times as it
  likes before the turn deadline. The turn resolves with the **last staged
  move whose server timestamp precedes the turn's `endTime`** — later writes
  simply supersede earlier ones.
- **Optional early commit.** Adding a snake to
  `moveStatuses/{turn}.movedPlayerIDs` signals "this snake is done", letting
  the turn resolve early once every alive snake has committed. A centaur that
  wants the full staging window simply doesn't commit and rides the turn
  timer.
- **Push-based game discovery.** At game start the server writes an invite
  doc under `centaurs/{centaurId}/games/{gameId}`, so a centaur discovers its
  games with a single collection listener.

## Authentication

### Per-centaur API key → Firebase custom token

This is the established Firebase approach for non-human principals
("custom auth system" / service-to-service):

1. **Key issuance** — the centaur owner (signed in as themselves) calls the
   `createCentaurApiKey` callable with a `centaurId` they own. The server
   generates an opaque key (`ttc_…`), stores only its SHA-256 hash in the
   `centaurCredentials/{centaurId}` document (a collection with no security
   rules, so it is unreadable and unwritable by every client), and returns
   the plaintext once. Calling it again rotates the key.
   `getCentaurApiKeyStatus` reports whether a key is configured — the
   plaintext is never recoverable.
2. **Token exchange** — the centaur calls the public `exchangeCentaurApiKey`
   callable with `{ centaurId, apiKey }`. After a constant-time hash
   comparison the server mints a **Firebase custom token** (Admin SDK
   `createCustomToken`) with uid `centaur:<centaurId>` and claims
   `{ centaur: true, centaurId, centaurOwner }`.
3. **Sign-in** — the centaur calls `signInWithCustomToken` with any Firebase
   client SDK. The SDK manages refresh automatically; if the process
   restarts, the centaur just re-exchanges its API key. Rotating the key
   (step 1) is how an owner revokes a leaked credential.

The `centaur:` uid prefix guarantees a centaur principal can never collide
with a human uid, and rules distinguish centaurs by
`request.auth.token.centaur == true` rather than by uid shape.

### Authorizing per-snake writes

At game start the server writes
`sessions/{sessionID}/games/{gameID}/meta/centaurMap`:

```
{ players: { [snakeID]: centaurId }, createdAt }
```

Every snake maps to the centaur whose team it belongs to (`centaurId` equals
the snake's `teamID`). Rules `get()` this doc and allow a centaur to stage or
commit for a snake iff `players[snakeID] == request.auth.token.centaurId`.

## Snake expansion

Snakes are generated server-side at game start from the setup's `teams` ×
`snakesPerTeam`: for each team in setup order and `k = 0..snakesPerTeam-1`,

- `id` = `team.id` for the first snake, `` `${team.id}#${k + 1}` `` for the
  rest (i.e. `centaurId`, `centaurId#2`, `centaurId#3`, …)
- `teamID` = `team.id` (== the centaur id)
- `letter` = `"A"`, `"B"`, `"C"`, … by index within the team

The game document's `setup.gamePlayers` carries the expanded list, so a
centaur finds its snakes with `gamePlayer.teamID === centaurId`. Display
names are `${team.name} ${letter}`.

## Protocol reference

All paths are under the default Firestore database. Game and turn data are
world-readable; the centaur-specific surfaces are:

| Path | Access | Purpose |
| --- | --- | --- |
| `centaurs/{centaurId}/games/{gameId}` | read (public), server-written | Game invite: `{ sessionID, gameID, snakeIDs, createdAt }` |
| `sessions/{s}/games/{g}` | read (public) | Game doc; `turns` array grows by one per resolved turn |
| `sessions/{s}/games/{g}/meta/centaurMap` | read (public), server-written | Snake → centaur ownership map used by rules |
| `sessions/{s}/games/{g}/moveStatuses/{turn}` | read (public); centaurs may `arrayUnion` **one owned snake per write** into `movedPlayerIDs` | Commit signal for early turn resolution |
| `sessions/{s}/games/{g}/privateMoves` | create for owned snakes; read only one's OWN moves (queries must filter `playerID` to an owned snake so rules can prove it) | Staged moves; repeatable per snake per turn. Read-back lets a centaur confirm which staged move the server will use (latest server timestamp ≤ `endTime` wins) |

A staged move document:

```jsonc
{
  "gameID": "<gameId>",
  "moveNumber": 7,                    // the turn being answered
  "playerID": "<snakeId>",            // centaurId or centaurId#k
  "move": 123,                        // FULL-board index of the target cell
  "timestamp": serverTimestamp()      // required: server time
}
```

Note that `move` is an index into the **full board** (including the 1-cell
perimeter), with y increasing downward — the same convention `processTurn`
consumes. Centaurs that think in stripped-perimeter, y-flipped coordinates
must convert; the reference implementation in Chris-Centaur
(`src/firebase/translate.ts`) applies the exact transform.

### Turn loop

1. Listen to `centaurs/{centaurId}/games` (ordered by `createdAt desc`) and
   open a listener on each new game doc.
2. On each game snapshot, read `turns.length - 1` as the current turn
   number. Skip turns already handled; stop when the final turn has
   `winners`.
3. For each owned, alive snake (via `setup.gamePlayers` where
   `teamID == centaurId`): compute a move and create a `privateMoves` doc.
   Re-stage freely as your search improves — last write before
   `turn.endTime` wins.
4. Optionally commit each snake (`movedPlayerIDs` arrayUnion, one snake per
   write) when you're confident; all-committed turns resolve immediately.

### Turns are append-only and immutable

**A turn is written exactly once and never modified — deadline included.**
`turns` only ever grows by one, so a game-document snapshot that does not
advance `turns.length` carries no new turn state and can be ignored outright.

Turn 0 is an ordinary turn under that rule. It is created by a single
idempotent start transaction (`functions/src/utils/startGame.ts`) and stamped
with its window there and nowhere else — `setup.firstTurnTime` seconds rather
than `maxTurnTime`, so centaurs have time to arrive — then announced by the
same `announceTurn()` every later turn goes through.

This is what makes the staging read-back sound: a staged move is resolved
against the snake's head as the turn records it, so a board that changed
underneath a staged write would silently invalidate it.

### Applied moves and the default policy

When a turn resolves, each new `Turn` document's `moves` map records the
move index **actually applied** for every snake — the winning staged move,
or the engine's default when nothing valid was staged. The default policy is
deterministic: **continue the previous move** (step in the head−neck
direction), falling back to the first in-bounds adjacent cell for a snake
with no direction yet. Clients can therefore both read the authoritative
applied moves from the next turn and accurately predict what an unstaged,
committed snake will do.

### Timing semantics

- The staging window closes at `turn.endTime` (server timestamp filter in
  `processTurn`) **or** as soon as every alive snake has committed,
  whichever comes first.
- **Committing is binding.** Once a snake is in `movedPlayerIDs`, the rules
  reject any further `privateMoves` creates for that snake for the turn:
  the staged move at commit time (or the engine default, if nothing was
  staged) is guaranteed to be the move that plays. This makes
  `movedPlayerIDs` represent true commitment, so clients can reason about a
  committed snake's move immediately instead of waiting for resolution.
  Commit a snake only after its intended move is confirmed staged.
- `turn.endTime` is included in the game doc, so centaurs can budget their
  own compute (e.g. commit `bufferMs` before the deadline).

## Deployment notes

- `exchangeCentaurApiKey` mints custom tokens, which requires the functions
  runtime service account to hold **Service Account Token Creator**
  (`iam.serviceAccounts.signBlob`) on itself. `scripts/bootstrap-gcp-project.sh`
  (step 8) grants this; run it once per project before relying on the
  exchange in production.
- All three centaur-auth callables (`createCentaurApiKey`,
  `exchangeCentaurApiKey`, and `getCentaurApiKeyStatus`) need the usual
  `allUsers` invoker grant (step 9 of the bootstrap script). Deploying
  function code alone does not automatically repair a missing IAM invoker
  grant. To repair an existing project without rerunning the full
  infrastructure bootstrap, run
  `bash scripts/grant-callable-invokers.sh tactic-toes-cyphid-dev`.
- No extra Cloud Tasks queues or Firestore indexes are required.

## Reference client

Chris-Centaur is the reference implementation of this interface: sign-in and
key exchange, invite listener, board translation, staged writes, and buffered
commit all live under its `src/firebase/` directory.
