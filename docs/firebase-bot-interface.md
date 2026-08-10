# Firebase Bot Interface

Bots can now connect to TacticToes **directly through Firebase** instead of
(or in addition to) the Battlesnake-inspired HTTP interface. A
Firebase-connected bot signs in to Firebase Auth as a first-class *bot
principal*, listens to game documents in Firestore, and submits moves by
writing documents — no inbound HTTP endpoint required.

The two interfaces coexist: a bot registered with a URL keeps receiving HTTP
`/move` pokes exactly as before, whether or not it also connects via
Firebase.

## What the interface gives you

- **One bot identity, many snakes.** In Team Snek a single bot can own
  several snakes (the original + clones). The bot signs in once and acts for
  every snake mapped to it, each with its own staged move.
- **Move staging.** A bot may stage a move for a snake as many times as it
  likes before the turn deadline. The turn resolves with the **last staged
  move whose server timestamp precedes the turn's `endTime`** — later writes
  simply supersede earlier ones. (This was already the server's resolution
  rule in `processTurn`; the Firebase interface makes it usable.)
- **Optional early commit.** Adding a snake to
  `moveStatuses/{turn}.movedPlayerIDs` signals "this snake is done", letting
  the turn resolve early once every alive player has committed — same as the
  HTTP flow. A bot that wants the full staging window simply doesn't commit
  and rides the turn timer.
- **Push-based game discovery.** At game start the server writes an invite
  doc under `bots/{botId}/games/{gameId}`, so a bot discovers its games with
  a single collection listener instead of needing to be woken over HTTP.

## Authentication design

### Why not "accept writes from a particular domain"?

Firestore security rules cannot see where a request came from. A rule
evaluates only `request.auth` (the verified Firebase Auth token),
`request.resource` (the data being written), existing documents it
explicitly `get()`s, and App Check state. The origin domain, IP, or reverse
DNS of the caller are not available in rules — and even if they were,
`Origin`/`Referer`-style signals are attacker-controlled headers, and
"requests from domain X" is not an authenticatable property of a TCP client.
Firebase App Check is the closest concept, but it attests *app integrity*
(is this my iOS/Android/Web app, via device attestation) rather than *server
identity*, and it does not support "any backend hosted at this domain".

So yes: every bot needs a credential. There is no rules-only way to trust a
domain. What we can do — and did — is make the credential cheap to issue and
use, via the standard pattern below.

### The pattern: per-bot API key → Firebase custom token

This is the established Firebase approach for non-human principals
("custom auth system" / service-to-service):

1. **Key issuance** — the bot owner (signed in as themselves, via either the
   web UI or any client) calls the `createBotApiKey` callable with a
   `botId` they own. The server generates an opaque key (`ttb_…`), stores
   only its SHA-256 hash in the `botCredentials/{botId}` document (a
   collection with no security rules, so it is unreadable and unwritable by
   every client), and returns the plaintext once. Calling it again rotates
   the key. Because issuance is just a callable + Firestore doc, bots
   created through the old HTTP flow and the new Firebase flow are handled
   identically — the key is an *addition* to a bot record, not a different
   kind of bot.
2. **Token exchange** — the bot calls the public `exchangeBotApiKey`
   callable with `{ botId, apiKey }`. After a constant-time hash comparison
   the server mints a **Firebase custom token** (Admin SDK
   `createCustomToken`) with uid `bot:<botId>` and claims
   `{ bot: true, botId, botOwner }`.
3. **Sign-in** — the bot calls `signInWithCustomToken` with any Firebase
   client SDK. The SDK manages refresh automatically; if the process
   restarts, the bot just re-exchanges its API key. Rotating the key (step
   1) is how an owner revokes a leaked credential.

The `bot:` uid prefix guarantees a bot principal can never collide with a
human uid, and rules distinguish bots by `request.auth.token.bot == true`
rather than by uid shape.

### Authorizing per-snake writes

At game start the server writes
`sessions/{sessionID}/games/{gameID}/meta/botMap`:

```
{ players: { [gamePlayerID]: underlyingBotID } }
```

covering originals (`gamePlayerID == botID`) and Team Snek clones
(`gamePlayerID == "<botID>#<suffix>"` with `botRef` pointing back). Rules
`get()` this doc and allow a bot to stage or commit for a snake iff
`players[snakeID] == request.auth.token.botId`. Humans keep the existing
`auth.uid == playerID` path untouched.

## Protocol reference

All paths are under the default Firestore database. Game and turn data are
world-readable (as before); the bot-specific surfaces are:

| Path | Access | Purpose |
| --- | --- | --- |
| `bots/{botId}/games/{gameId}` | read (public), server-written | Game invite: `{ sessionID, gameID, gameType, snakeIDs, createdAt }` |
| `sessions/{s}/games/{g}` | read (public) | Game doc; `turns` array grows by one per resolved turn |
| `sessions/{s}/games/{g}/meta/botMap` | read (public), server-written | Snake → bot ownership map used by rules |
| `sessions/{s}/games/{g}/moveStatuses/{turn}` | read (public); bots may `arrayUnion` **one owned snake per write** into `movedPlayerIDs` | Commit signal for early turn resolution |
| `sessions/{s}/games/{g}/privateMoves` | create for owned snakes; read only one's OWN moves (queries must filter `playerID` to an owned snake so rules can prove it) | Staged moves; repeatable per snake per turn. Read-back lets a bot confirm which staged move the server will use (latest server timestamp ≤ `endTime` wins) |

A staged move document is the same shape humans write:

```jsonc
{
  "gameID": "<gameId>",
  "moveNumber": 7,                    // the turn being answered
  "playerID": "<snakeId>",            // original bot id or clone id
  "move": 123,                        // FULL-board index of the target cell
  "timestamp": serverTimestamp()      // required: server time
}
```

Note that `move` is an index into the **full board** (including the 1-cell
perimeter), with y increasing downward — the same convention `processTurn`
consumes. Bots that think in Battlesnake API coordinates (perimeter
stripped, y flipped) must convert; the reference implementation in
Chris-Centaur (`src/firebase/translate.ts`) mirrors the exact transform the
HTTP notifier applies.

### Turn loop for a Firebase bot

1. Listen to `bots/{botId}/games` (ordered by `createdAt desc`) and open a
   listener on each new game doc.
2. On each game snapshot, read `turns.length - 1` as the current turn
   number. Skip turns already handled; stop when the final turn has
   `winners`.
3. For each owned, alive snake (via `setup.gamePlayers` where
   `botRef ?? id == botId`): compute a move and create a `privateMoves`
   doc. Re-stage freely as your search improves — last write before
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
than `maxTurnTime`, so players and bots have time to arrive — then announced by
the same `announceTurn()` every later turn goes through.

This is what makes the staging read-back sound: a staged move is resolved
against the snake's head as the turn records it, so a board that changed
underneath a staged write would silently invalidate it.

### Player names

Every entry in the game document's `setup.gamePlayers` carries a resolved
`displayName` and `displayEmoji` — bot originals, Team Snek clones and humans
alike — so a Firebase-connected bot can name every snake from the game document
alone, matching the `name`/`emoji` the HTTP `/move` payload would carry. (In the
lobby document under `setups/`, those fields remain clone-only overrides.)

### Applied moves and the default policy

When a turn resolves, each new `Turn` document's `moves` map records the
move index **actually applied** for every player — the winning staged move,
or the engine's default when nothing valid was staged. The default policy is
deterministic: **continue the previous move** (step in the head−neck
direction), falling back to the first in-bounds adjacent cell for a snake
with no direction yet. Clients can therefore both read the authoritative
applied moves from the next turn and accurately predict what an unstaged,
committed snake will do.

### Timing semantics

- The staging window closes at `turn.endTime` (server timestamp filter in
  `processTurn`) **or** as soon as every alive player has committed,
  whichever comes first.
- **Committing is binding.** Once a player is in `movedPlayerIDs`, the rules
  reject any further `privateMoves` creates for that player for the turn:
  the staged move at commit time (or the engine default, if nothing was
  staged) is guaranteed to be the move that plays. This makes
  `movedPlayerIDs` represent true commitment, so clients can reason about a
  committed player's move immediately instead of waiting for resolution.
  Commit your snake only after its intended move is confirmed staged.
- `turn.endTime` is included in the game doc, so bots can budget their own
  compute (e.g. commit `bufferMs` before the deadline).

## Deployment notes

- `exchangeBotApiKey` mints custom tokens, which requires the functions
  runtime service account to hold **Service Account Token Creator**
  (`iam.serviceAccounts.signBlob`) on itself. `scripts/bootstrap-gcp-project.sh`
  (step 8) now grants this; run it once per project before relying on the
  exchange in production.
- All three bot-auth callables (`createBotApiKey`, `exchangeBotApiKey`, and
  `getBotApiKeyStatus`) need the usual `allUsers` invoker grant (step 9 of the
  bootstrap script) like `wakeBot`. Deploying function code alone does not
  automatically repair a missing IAM invoker grant.
- To repair an existing project without rerunning the full infrastructure
  bootstrap, run
  `bash scripts/grant-callable-invokers.sh tactic-toes-cyphid-dev`.
- No new Cloud Tasks queues or indexes are required.

## Alternatives considered

- **Domain/origin allow-listing in rules** — impossible; see above.
- **One service account per bot** — real GCP service accounts authenticate
  servers fine, but provisioning IAM per hobby bot is heavy, keys are
  harder to rotate from a game UI, and Firestore rules would see them as
  admin traffic (bypassing rules entirely) unless scoped carefully.
- **Anonymous auth + claim code** — the bot signs in anonymously and
  redeems a one-time code that binds custom claims to its uid. Fewer
  moving parts at exchange time, but identity dies with the anonymous
  session and re-binding needs another code; the custom-token pattern keeps
  the bot's identity stable across restarts with a single stored secret.
- **Firebase App Check custom provider** — could *supplement* the API key
  (defense in depth), but cannot replace per-bot identity, which rules need
  for per-snake authorization.
