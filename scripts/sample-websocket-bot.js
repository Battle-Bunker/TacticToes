#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Sample WebSocket bot for the Tactic Toes WebSocket Bot API.
 *
 * Usage:
 *   PORT=8080 node scripts/sample-websocket-bot.js
 *
 * Then point a Tactic Toes bot (with connectionType="websocket") at
 *   ws://localhost:8080
 *
 * Behaviour:
 *   - On `move_request`, immediately stages a "right" move so something is
 *     on the clock.
 *   - 100ms later, picks a random allowed direction and commits it.
 *   - Logs `game_end` messages.
 *
 * See docs/BOT_WEBSOCKET_API.md for the full protocol.
 */

const { WebSocketServer } = require("ws")

const PORT = Number(process.env.PORT || 8080)

const wss = new WebSocketServer({ port: PORT })
console.log(`Sample WS bot listening on ws://localhost:${PORT}`)

wss.on("connection", (ws, req) => {
  const remote = req.socket.remoteAddress
  console.log(`[ws] connection from ${remote}`)

  ws.on("message", (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch (e) {
      console.warn("[ws] bad json from server:", e.message)
      return
    }

    if (msg.type === "move_request") {
      const requestId = msg.requestId
      const turn = msg.payload?.turn
      console.log(`[ws] move_request requestId=${requestId} turn=${turn}`)

      ws.send(
        JSON.stringify({
          type: "stage_move",
          requestId,
          move: "right",
          shout: "thinking…",
        })
      )

      setTimeout(() => {
        const choices = ["up", "down", "left", "right"]
        const move = choices[Math.floor(Math.random() * choices.length)]
        ws.send(
          JSON.stringify({
            type: "commit_move",
            requestId,
            move,
            shout: `going ${move}!`,
          })
        )
        console.log(`[ws] commit_move ${move}`)
      }, 100)
    } else if (msg.type === "game_end") {
      console.log(`[ws] game_end requestId=${msg.requestId}`, msg.payload?.winners)
    } else {
      console.log("[ws] unknown msg type", msg.type)
    }
  })

  ws.on("close", (code, reason) => {
    console.log(`[ws] closed (${code}) ${reason?.toString?.() || ""}`)
  })
})
