# Tactic Toes — WebSocket Bot API

This document describes the **WebSocket bot interface** used by Tactic Toes for
**snek-variant games** (`snek`, `teamsnek`, `kingsnek`). It mirrors the existing
HTTP bot interface as closely as possible, with one important addition: the
WebSocket interface lets a bot **stage** a move and later **commit** it, so the
turn can end early once every player has committed.

The intent is to prepare the way for a chess-clock style timer that rewards
players for submitting moves earlier than the turn deadline. That clock is *not*
implemented here, but the API described below is designed to support it.

---

## 1. Choosing a connection type

A bot owner configures the connection style on each bot via the **`connectionType`**
field in the `bots/{botId}` Firestore document:

| `connectionType` | Meaning                                                                                  | Allowed `capabilities` |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| `"http"`         | Default. Server makes `POST {url}/move` and `POST {url}/end` HTTP requests.              | Any game type.         |
| `"websocket"`    | Server opens a WebSocket connection to `url` per turn.                                   | **snek-only** (`snek`, `teamsnek`, `kingsnek`). |

If the field is **absent**, `"http"` is assumed (full backward compatibility).

The bot's `url` is interpreted as:

* `http://…` / `https://…` for HTTP bots.
* `ws://…` / `wss://…` for WebSocket bots.

The URL is the **WebSocket connection endpoint** itself; there are no
sub-paths. The server connects directly to it once per turn.

---

## 2. Lifecycle of a WebSocket bot turn

For every turn the server:

1. **Opens** a new WebSocket connection to the bot's `url`.
2. **Sends** one `move_request` message containing the same payload that the
   HTTP `/move` endpoint receives.
3. **Listens** for any number of `stage_move` and at most one `commit_move`
   message from the bot.
4. **Closes** the connection when either:
   * the bot sends a `commit_move`, **or**
   * the turn deadline elapses, **or**
   * the bot closes its side first.

The server may also send a single `game_end` message at the end of the game
(equivalent to HTTP `POST /end`). For game-end notifications the server opens a
fresh, short-lived connection just to deliver that message.

All messages are JSON-encoded text frames (`opcode 0x1`).

---

## 3. Server → Bot messages

### 3.1 `move_request`

```json
{
  "type": "move_request",
  "requestId": "<sessionID>:<gameID>:<turn>",
  "payload": {
    "game":  { /* identical to HTTP /move */ },
    "turn":  17,
    "board": { /* identical to HTTP /move */ },
    "you":   { /* identical to HTTP /move */ }
  }
}
```

`payload` is **byte-for-byte the same object** that an HTTP bot receives in its
`/move` POST body (Battlesnake-compatible, with the Tactic Toes additions for
team mode, kingsnek, fertile tiles, invulnerability potions, etc.).

`payload.game.turnExpiryTime` is the Unix epoch millisecond at which the turn
ends. Use it to plan how late you can keep staging.

`requestId` uniquely identifies this turn's request. All replies for the
turn must echo this `requestId`.

### 3.2 `game_end`

```json
{
  "type": "game_end",
  "requestId": "<sessionID>:<gameID>:end",
  "payload": {
    "game":    { /* same shape as /end */ },
    "turn":    42,
    "scores":  { "<playerID>": 7, ... },
    "winners": [ { "playerID": "...", "score": 7, "teamID": "...", "teamScore": 12 } ],
    "you":     { "id": "<botID>", "name": "<botID>" }
  }
}
```

Sent on a one-shot WebSocket connection at the end of the game. No reply is
expected — the server closes shortly after writing the message.

---

## 4. Bot → Server messages

The bot may emit any number of `stage_move` messages followed by **at most one**
`commit_move`. After `commit_move` the connection is considered closed; further
messages are ignored.

A bot that prefers the simple "single shot" HTTP-style behaviour can just send
one `commit_move` and stop — it is functionally equivalent to an HTTP bot.

### 4.1 `stage_move` — replaceable, non-final

```json
{
  "type": "stage_move",
  "requestId": "<echoed from move_request>",
  "move": "up" | "down" | "left" | "right",
  "shout": "optional flavour text"
}
```

* Records the move into the player's `privateMoves`. The newest staged move
  wins (the existing latest-wins resolution already used for moves).
* Does **not** mark the player as having "moved" in `moveStatuses`, so the
  turn will not end early because of this message.
* Can be sent any number of times before `commit_move` or the deadline.

### 4.2 `commit_move` — final

```json
{
  "type": "commit_move",
  "requestId": "<echoed from move_request>",
  "move": "up" | "down" | "left" | "right",
  "shout": "optional flavour text"
}
```

* Stages the move (same as `stage_move`) **and** marks the player as committed
  in `moveStatuses.movedPlayerIDs`.
* Once every alive player has committed, the turn is processed immediately
  (existing `onMoveCreated` behaviour).
* If a bot wants to commit its previously-staged move without changing it,
  the `move` field can be omitted; the most recently staged move (if any) is
  used. If neither a previous stage nor a `move` is present, the commit is
  rejected and logged.

### 4.3 What happens at the deadline

If the bot has not committed by the turn deadline, the server closes the
connection and processes the turn as usual. The latest staged move (if any)
is the move that gets applied. Bots with no staged move are treated the same
as silent HTTP bots: their last allowed move is used by the snek processor's
fallback logic.

---

## 5. Errors and conventions

* Messages with `type` other than the values above are **ignored** with a
  server-side log entry (forward-compatible).
* Any malformed JSON closes the connection with code `1003` (Unsupported
  Data) and the bot is treated as "no move this turn".
* The server does not authenticate to the bot; if your bot needs auth,
  embed a token in the WebSocket URL (e.g. `wss://example.com/ws?token=…`).
* The `move` direction is interpreted exactly as in the HTTP bot interface:
  `"up"`, `"down"`, `"left"`, `"right"` from the `you.head` position, with
  the same axis conventions (y-axis flipped, perimeter excluded).
* The server tolerates additional unknown fields on incoming messages.

---

## 6. Minimal example bot (Node.js)

```js
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "move_request") {
      // Stage early so we have something on the clock,
      // then commit once we've actually thought about it.
      ws.send(JSON.stringify({
        type: "stage_move",
        requestId: msg.requestId,
        move: "up",
      }));

      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "commit_move",
          requestId: msg.requestId,
          move: "right",
        }));
      }, 200);
    }

    if (msg.type === "game_end") {
      // No reply expected.
    }
  });
});
```

A more complete reference implementation lives at
[`scripts/sample-websocket-bot.js`](../scripts/sample-websocket-bot.js).

---

## 7. Why snek-only?

The HTTP bot interface is currently only consumed by snek-variant games
(`notifyBots` only sends move-requests for snek players' bots in practice — the
move payload schema is Battlesnake-shaped). The WebSocket interface adopts
exactly the same payload, so it is equally restricted. A bot configured with
`connectionType: "websocket"` may therefore only declare snek-variant
`capabilities` (`snek`, `teamsnek`, `kingsnek`); the Bots page UI and
Firestore security rules enforce this.
