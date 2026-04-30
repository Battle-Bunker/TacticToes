/**
 * Integration test for the WebSocket bot path through the live notifyBots
 * dispatcher, against a real Firestore emulator and a real ws bot.
 *
 * Requires the Firestore emulator to be reachable. We auto-skip if it isn't.
 */

import { GameState, Bot } from "../types/Game"
import { WebSocketServer, WebSocket } from "ws"

const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST
const RUN = !!FIRESTORE_HOST
const maybeDescribe: jest.Describe = RUN ? describe : describe.skip

maybeDescribe("notifyBots end-to-end with websocket bot", () => {
  let admin: typeof import("firebase-admin")
  let notifyBots: typeof import("./notifyBots").notifyBots
  let wss: WebSocketServer
  let botUrl: string

  const sessionID = `test-session-${Date.now()}`
  const gameID = "g1"
  const botId = "wsbot1"

  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-project"

    admin = await import("firebase-admin")
    if (!admin.apps.length) {
      admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT })
    }

    notifyBots = (await import("./notifyBots")).notifyBots

    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()))
    const address = wss.address() as { port: number }
    botUrl = `ws://127.0.0.1:${address.port}`

    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "move_request") {
          ws.send(
            JSON.stringify({
              type: "stage_move",
              requestId: msg.requestId,
              move: "left",
            })
          )
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "commit_move",
                requestId: msg.requestId,
                move: "right",
              })
            )
          }, 30)
        }
      })
    })
  })

  afterAll(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
    if (admin && admin.apps.length) {
      await Promise.all(admin.apps.map((a) => a?.delete()))
    }
  })

  it("dispatches to the websocket bot, records the move, and marks committed", async () => {
    const db = admin.firestore()

    const bot: Bot = {
      id: botId,
      owner: "test-owner",
      name: "WS Bot",
      url: botUrl,
      capabilities: ["snek"],
      emoji: "🤖",
      colour: "hsl(200, 50%, 50%)",
      public: false,
      connectionType: "websocket",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createdAt: 0 as any,
    }
    await db.collection("bots").doc(botId).set(bot)

    const { Timestamp } = await import("firebase-admin/firestore")
    const gameData: GameState = {
      setup: {
        gameType: "snek",
        gamePlayers: [{ id: botId, type: "bot" }],
        boardWidth: 13,
        boardHeight: 13,
        playersReady: [],
        maxTurnTime: 10,
        startRequested: true,
        started: true,
        timeCreated: Timestamp.fromMillis(0),
      },
      turns: [
        {
          playerHealth: { [botId]: 100 },
          startTime: Timestamp.fromMillis(0),
          endTime: Timestamp.fromMillis(Date.now() + 10000),
          scores: { [botId]: 0 },
          alivePlayers: [botId],
          food: [],
          hazards: [],
          playerPieces: { [botId]: [13 * 6 + 6, 13 * 6 + 5, 13 * 6 + 4] },
          allowedMoves: { [botId]: [] },
          walls: [],
          clashes: [],
          moves: {},
          winners: [],
        },
      ],
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: null,
    }
    const gameRef = db.doc(`sessions/${sessionID}/games/${gameID}`)
    await gameRef.set(gameData)

    const moveStatusRef = db.doc(
      `sessions/${sessionID}/games/${gameID}/moveStatuses/0`
    )
    await moveStatusRef.set({
      moveNumber: 0,
      alivePlayerIDs: [botId],
      movedPlayerIDs: [],
    })

    await notifyBots(sessionID, gameID, 0, Date.now() + 5000)

    const moves = await db
      .collection(`sessions/${sessionID}/games/${gameID}/privateMoves`)
      .get()
    const moveData = moves.docs.map((d) => d.data())
    // We expect at least 2 (one stage + the commit re-stages with the
    // committed direction). The committed direction is "right" so the move
    // index should be the head + 1.
    expect(moveData.length).toBeGreaterThanOrEqual(2)
    const headIndex = 13 * 6 + 6
    const movesForBot = moveData.filter((m) => m.playerID === botId)
    expect(movesForBot.length).toBe(moveData.length)
    // Most recent move (right of head)
    const expectedRight = headIndex + 1
    expect(movesForBot.some((m) => m.move === expectedRight)).toBe(true)

    const moveStatusAfter = (await moveStatusRef.get()).data() as {
      movedPlayerIDs: string[]
    }
    expect(moveStatusAfter.movedPlayerIDs).toContain(botId)
  }, 30000)
})
