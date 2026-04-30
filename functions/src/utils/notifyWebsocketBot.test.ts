import { Bot, GameState } from "../types/Game"

// We use the real `ws` package in-process: a real `ws` server hosts a fake bot,
// and the function under test connects to it. Firestore is mocked so we can
// observe the writes without spinning up the emulator.

const stagedMoves: Array<{
  playerID: string
  moveNumber: number
  move: number
}> = []
const committedPlayers: Set<string> = new Set()

jest.mock("firebase-admin", () => {
  const addMock = jest.fn((data: { playerID: string; moveNumber: number; move: number }) => {
    stagedMoves.push({
      playerID: data.playerID,
      moveNumber: data.moveNumber,
      move: data.move,
    })
    return Promise.resolve({ id: `m${stagedMoves.length}` })
  })

  const updateMock = jest.fn((data: { movedPlayerIDs: { __arrayUnion: string[] } }) => {
    const ids = data.movedPlayerIDs.__arrayUnion
    for (const id of ids) committedPlayers.add(id)
    return Promise.resolve()
  })

  return {
    firestore: () => ({
      collection: () => ({ add: addMock }),
      doc: () => ({ update: updateMock }),
    }),
  }
})

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => "FAKE_TS",
    arrayUnion: (...ids: string[]) => ({ __arrayUnion: ids }),
  },
}))

jest.mock("firebase-functions/logger", () => ({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}))

import { WebSocketServer, WebSocket } from "ws"
import { notifyWebsocketBot } from "./notifyWebsocketBot"

const startFakeBot = async (
  handler: (ws: WebSocket) => void
): Promise<{ url: string; close: () => Promise<void> }> => {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()))
  const address = wss.address() as { port: number }
  wss.on("connection", handler)
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => resolve())
      }),
  }
}

const buildGameData = (botId: string): GameState => ({
  setup: {
    gameType: "snek",
    gamePlayers: [{ id: botId, type: "bot" }],
    boardWidth: 13,
    boardHeight: 13,
    playersReady: [],
    maxTurnTime: 10,
    startRequested: true,
    started: true,
    timeCreated: { toMillis: () => 0 } as never,
  },
  turns: [
    {
      playerHealth: { [botId]: 100 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startTime: { toMillis: () => 0 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      endTime: { toMillis: () => 1000 } as any,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  timeCreated: { toMillis: () => 0 } as any,
  timeFinished: null,
})

const bot: Bot = {
  id: "bot1",
  owner: "owner",
  name: "Test Bot",
  url: "",
  capabilities: ["snek"],
  emoji: "🤖",
  colour: "hsl(0, 100%, 50%)",
  public: false,
  connectionType: "websocket",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createdAt: 0 as any,
}

describe("notifyWebsocketBot", () => {
  beforeEach(() => {
    stagedMoves.length = 0
    committedPlayers.clear()
  })

  it("ends the turn when the bot commits", async () => {
    const fake = await startFakeBot((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        expect(msg.type).toBe("move_request")
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
        }, 10)
      })
    })

    const gameData = buildGameData(bot.id)
    const t0 = Date.now()
    await notifyWebsocketBot({
      sessionID: "s1",
      gameID: "g1",
      turnNumber: 0,
      turnExpiryTime: t0 + 5000,
      bot: { ...bot, url: fake.url },
      payload: { game: { id: "g1" }, turn: 0, board: {}, you: { id: bot.id } },
      gameData,
    })

    expect(stagedMoves.length).toBe(2)
    expect(stagedMoves[0].move).toBeDefined()
    expect(committedPlayers.has(bot.id)).toBe(true)
    // Should have completed well before the deadline.
    expect(Date.now() - t0).toBeLessThan(2000)
    await fake.close()
  })

  it("supports multiple stage_move calls without committing, then times out", async () => {
    const fake = await startFakeBot((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        expect(msg.type).toBe("move_request")
        ws.send(
          JSON.stringify({
            type: "stage_move",
            requestId: msg.requestId,
            move: "up",
          })
        )
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "stage_move",
              requestId: msg.requestId,
              move: "down",
            })
          )
        }, 10)
      })
    })

    const gameData = buildGameData(bot.id)
    const t0 = Date.now()
    await notifyWebsocketBot({
      sessionID: "s1",
      gameID: "g1",
      turnNumber: 0,
      turnExpiryTime: t0 + 600,
      bot: { ...bot, url: fake.url },
      payload: { game: { id: "g1" }, turn: 0, board: {}, you: { id: bot.id } },
      gameData,
    })

    // Two stages, no commit — bot still gets its latest staged move applied.
    expect(stagedMoves.length).toBe(2)
    expect(committedPlayers.has(bot.id)).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500)
    await fake.close()
  })

  it("commit_move with no direction commits the previously staged move", async () => {
    const fake = await startFakeBot((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        ws.send(
          JSON.stringify({
            type: "stage_move",
            requestId: msg.requestId,
            move: "up",
          })
        )
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "commit_move",
              requestId: msg.requestId,
              // no `move` — should commit the previously staged "up"
            })
          )
        }, 10)
      })
    })

    const gameData = buildGameData(bot.id)
    await notifyWebsocketBot({
      sessionID: "s1",
      gameID: "g1",
      turnNumber: 0,
      turnExpiryTime: Date.now() + 5000,
      bot: { ...bot, url: fake.url },
      payload: { game: { id: "g1" }, turn: 0, board: {}, you: { id: bot.id } },
      gameData,
    })

    expect(stagedMoves.length).toBe(1)
    expect(committedPlayers.has(bot.id)).toBe(true)
    await fake.close()
  })

  it("commit_move with no direction and no prior stage is rejected", async () => {
    const fake = await startFakeBot((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        ws.send(
          JSON.stringify({
            type: "commit_move",
            requestId: msg.requestId,
          })
        )
      })
    })

    const gameData = buildGameData(bot.id)
    await notifyWebsocketBot({
      sessionID: "s1",
      gameID: "g1",
      turnNumber: 0,
      turnExpiryTime: Date.now() + 600,
      bot: { ...bot, url: fake.url },
      payload: { game: { id: "g1" }, turn: 0, board: {}, you: { id: bot.id } },
      gameData,
    })

    expect(stagedMoves.length).toBe(0)
    expect(committedPlayers.has(bot.id)).toBe(false)
    await fake.close()
  })
})
