// Characterization tests for processTurn(): pin the transaction read/write
// choreography exactly as production performs it today.
//
// The Firestore Transaction is replaced by a recorder whose get/update/create
// answers match the real call shapes (doc snapshots expose data/id/ref/exists,
// query snapshots expose docs[].data()). admin.firestore() is mocked to hand
// out path-carrying refs so writes can be asserted by path.

import { Timestamp, Transaction } from "firebase-admin/firestore"
import {
  GameState,
  Move,
  Ranking,
  StartedGameSetup,
  Team,
  Turn,
} from "@shared/types/Game"
import { expandTeams } from "../utils/expandTeams"
import { createNewGame } from "../utils/createNewGame"
import { processTurn } from "./processTurn"

jest.mock("../utils/createNewGame")

// Minimal Firestore facade: refs are plain { path, id } objects and queries
// carry their collection path + where clause, so the recorder transaction can
// resolve them from canned data and the test can assert on paths.
jest.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: (path: string) => ({
      doc: (id: string) => ({ path: `${path}/${id}`, id }),
      where: (field: string, op: string, value: unknown) => ({
        kind: "query",
        path,
        field,
        op,
        value,
      }),
    }),
  }),
}))

interface FakeRef {
  path: string
  id: string
}

interface FakeQuery {
  kind: "query"
  path: string
  field: string
  op: string
  value: unknown
}

interface RecordedWrite {
  kind: "set" | "update" | "create"
  path: string
  data: Record<string, unknown>
}

class FakeTransaction {
  getPaths: string[] = []
  queryCalls: FakeQuery[] = []
  writes: RecordedWrite[] = []

  constructor(
    private docs: Map<string, unknown>,
    private queryDocs: Map<string, unknown[]>
  ) {}

  get(refOrQuery: FakeRef | FakeQuery): Promise<unknown> {
    if ("kind" in refOrQuery && refOrQuery.kind === "query") {
      this.queryCalls.push(refOrQuery)
      const docs = (this.queryDocs.get(refOrQuery.path) ?? []).map((data) => ({
        data: () => data,
      }))
      return Promise.resolve({ docs })
    }
    const ref = refOrQuery as FakeRef
    this.getPaths.push(ref.path)
    const exists = this.docs.has(ref.path)
    return Promise.resolve({
      id: ref.id,
      ref,
      exists,
      data: () => (exists ? this.docs.get(ref.path) : undefined),
    })
  }

  update(ref: FakeRef, data: Record<string, unknown>): this {
    this.writes.push({ kind: "update", path: ref.path, data })
    return this
  }

  create(ref: FakeRef, data: Record<string, unknown>): this {
    this.writes.push({ kind: "create", path: ref.path, data })
    return this
  }

  set(ref: FakeRef, data: Record<string, unknown>): this {
    this.writes.push({ kind: "set", path: ref.path, data })
    return this
  }

  asTransaction(): Transaction {
    return this as unknown as Transaction
  }
}

// 7x7 board fixture (same geometry as headToHead.test.ts): index = y * 7 + x,
// perimeter is wall.

const SESSION_ID = "session1"
const GAME_ID = "game1"
const GAME_PATH = `sessions/${SESSION_ID}/games/${GAME_ID}`
const NOW = 100_000

const teams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#00ff00" },
]

const mkSetup = (
  overrides: Partial<StartedGameSetup> = {}
): StartedGameSetup => ({
  teams,
  snakesPerTeam: 1,
  gamePlayers: expandTeams(teams, overrides.snakesPerTeam ?? 1),
  boardWidth: 7,
  boardHeight: 7,
  maxTurnTime: 5,
  startRequested: false,
  started: true,
  timeCreated: Timestamp.fromMillis(0),
  foodSpawnRate: 0,
  ...overrides,
})

const mkTurn = (
  playerPieces: { [playerID: string]: number[] },
  overrides: Partial<Turn> = {}
): Turn => {
  const ids = Object.keys(playerPieces)
  return {
    playerHealth: Object.fromEntries(ids.map((id) => [id, 100])),
    startTime: Timestamp.fromMillis(0),
    endTime: Timestamp.fromMillis(5000),
    scores: Object.fromEntries(ids.map((id) => [id, playerPieces[id].length])),
    alivePlayers: ids,
    food: [],
    hazards: [],
    playerPieces,
    clashes: [],
    moves: {},
    winners: [],
    // Every unit carries an orientation; irrelevant here (every test stages all
    // moves) beyond satisfying the Turn shape.
    orientation: Object.fromEntries(ids.map((id) => [id, { dx: 1, dy: 0 }])),
    ...overrides,
  }
}

const mkGameState = (setup: StartedGameSetup, turns: Turn[]): GameState => ({
  setup,
  turns,
  walls: [],
  timeCreated: Timestamp.fromMillis(0),
  timeFinished: null,
})

const mv = (playerID: string, move: number, atMillis: number): Move => ({
  gameID: GAME_ID,
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(atMillis),
})

const mkRanking = (overrides: Partial<Ranking> = {}): Ranking => ({
  currentMMR: 1000,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  gameHistory: [],
  lastUpdated: Timestamp.fromMillis(0),
  ...overrides,
})

const mkTransaction = (
  gameState: GameState,
  moves: Move[],
  rankings: { [teamID: string]: Ranking } = {}
): FakeTransaction => {
  const docs = new Map<string, unknown>([[GAME_PATH, gameState]])
  Object.entries(rankings).forEach(([teamID, ranking]) => {
    docs.set(`rankings/${teamID}`, ranking)
  })
  const queryDocs = new Map<string, unknown[]>([
    [`${GAME_PATH}/privateMoves`, moves],
  ])
  return new FakeTransaction(docs, queryDocs)
}

/** Unpacks the single turn from a FieldValue.arrayUnion sentinel. */
const arrayUnionTurn = (value: unknown): Turn => {
  const sentinel = value as { methodName?: string; elements?: Turn[] }
  expect(sentinel.methodName).toBe("FieldValue.arrayUnion")
  const elements = sentinel.elements ?? []
  expect(elements).toHaveLength(1)
  return elements[0]
}

const mockedCreateNewGame = createNewGame as jest.MockedFunction<
  typeof createNewGame
>

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Date, "now").mockReturnValue(NOW)
  mockedCreateNewGame.mockResolvedValue({ newGameID: "next-game" })
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("processTurn", () => {
  it("(i) resolves a normal turn: arrayUnions the new turn and creates the next moveStatus", async () => {
    const turn0 = mkTurn({ t1: [23, 16, 9], t2: [40, 39, 38] })
    const gameState = mkGameState(mkSetup(), [turn0])
    const tx = mkTransaction(gameState, [
      mv("t1", 24, 1000),
      mv("t2", 33, 2000),
    ])

    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result).toEqual({
      newTurnCreated: true,
      newTurnNumber: 1,
      turnDurationSeconds: 5,
    })

    // Moves were read for exactly this turn.
    expect(tx.queryCalls).toEqual([
      {
        kind: "query",
        path: `${GAME_PATH}/privateMoves`,
        field: "moveNumber",
        op: "==",
        value: 0,
      },
    ])

    expect(tx.writes).toHaveLength(2)

    const [turnWrite, statusWrite] = tx.writes
    expect(turnWrite.kind).toBe("update")
    expect(turnWrite.path).toBe(GAME_PATH)
    expect(Object.keys(turnWrite.data)).toEqual(["turns"])

    const nextTurn = arrayUnionTurn(turnWrite.data.turns)
    expect(nextTurn.playerPieces).toEqual({
      t1: [24, 23, 16],
      t2: [33, 40, 39],
    })
    expect(nextTurn.alivePlayers).toEqual(["t1", "t2"])
    expect(nextTurn.moves).toEqual({ t1: 24, t2: 33 })
    expect(nextTurn.winners).toEqual([])
    // The caller stamps the turn window from Date.now() and maxTurnTime.
    expect(nextTurn.startTime.toMillis()).toBe(NOW)
    expect(nextTurn.endTime.toMillis()).toBe(NOW + 5000)

    expect(statusWrite).toEqual({
      kind: "create",
      path: `${GAME_PATH}/moveStatuses/1`,
      data: {
        moveNumber: 1,
        alivePlayerIDs: ["t1", "t2"],
        movedPlayerIDs: [],
      },
    })

    expect(mockedCreateNewGame).not.toHaveBeenCalled()
  })

  it("(ii) does nothing when the requested turn is stale", async () => {
    const turn0 = mkTurn({ t1: [23, 16, 9], t2: [40, 39, 38] })
    const turn1 = mkTurn({ t1: [24, 23, 16], t2: [33, 40, 39] })
    const gameState = mkGameState(mkSetup(), [turn0, turn1])
    const tx = mkTransaction(gameState, [mv("t1", 25, 1000)])

    // Latest turn is 1; asking to process turn 0 must bail before any write.
    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result).toEqual({ newTurnCreated: false })
    expect(tx.writes).toEqual([])
    expect(tx.queryCalls).toEqual([])
    expect(tx.getPaths).toEqual([GAME_PATH])
    expect(mockedCreateNewGame).not.toHaveBeenCalled()
  })

  it("(iii) does nothing when the game is already finished", async () => {
    const turn0 = mkTurn(
      { t1: [23, 16, 9], t2: [40, 39, 38] },
      {
        winners: [
          {
            playerID: "t1",
            score: 3,
            winningSquares: [23, 16, 9],
            teamID: "t1",
            teamScore: 3,
          },
        ],
      }
    )
    const gameState = mkGameState(mkSetup(), [turn0])
    const tx = mkTransaction(gameState, [mv("t1", 24, 1000)])

    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result).toEqual({ newTurnCreated: false })
    expect(tx.writes).toEqual([])
    expect(mockedCreateNewGame).not.toHaveBeenCalled()
  })

  it("(iv) finishes the game: prepares ranking updates, stamps timeFinished and creates the next game", async () => {
    const turn0 = mkTurn({ t1: [23, 16, 9], t2: [40, 39, 38] })
    const gameState = mkGameState(mkSetup(), [turn0])
    // t2 drives into the bottom wall (cell 47) and dies; t1 wins.
    const tx = mkTransaction(
      gameState,
      [mv("t1", 24, 1000), mv("t2", 47, 2000)],
      { t1: mkRanking() } // t1 has a rankings doc, t2 does not
    )

    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result).toEqual({
      newTurnCreated: false,
      tournamentSchedule: undefined,
    })

    // Both rankings were read inside the transaction.
    expect(tx.getPaths).toEqual([GAME_PATH, "rankings/t1", "rankings/t2"])

    expect(tx.writes).toHaveLength(3)
    const [t1Write, t2Write, gameWrite] = tx.writes

    // Both teams started at 1000 MMR with 0 games: K = 64, expected score
    // 0.5, so the winner gains exactly +32 and the loser loses 32.
    expect(t1Write.kind).toBe("update") // doc exists -> update
    expect(t1Write.path).toBe("rankings/t1")
    const t1Ranking = t1Write.data as unknown as Ranking
    expect(t1Ranking.currentMMR).toBe(1032)
    expect(t1Ranking.gamesPlayed).toBe(1)
    expect(t1Ranking.wins).toBe(1)
    expect(t1Ranking.losses).toBe(0)
    expect(t1Ranking.gameHistory).toEqual([
      {
        sessionID: SESSION_ID,
        gameID: GAME_ID,
        timestamp: Timestamp.fromMillis(NOW),
        previousMMR: 1000,
        mmrChange: 32,
        placement: 1,
        opponents: [{ playerID: "t2", mmr: 1000, placement: 2 }],
      },
    ])

    expect(t2Write.kind).toBe("create") // doc missing -> create
    expect(t2Write.path).toBe("rankings/t2")
    const t2Ranking = t2Write.data as unknown as Ranking
    expect(t2Ranking.currentMMR).toBe(968)
    expect(t2Ranking.gamesPlayed).toBe(1)
    expect(t2Ranking.wins).toBe(0)
    expect(t2Ranking.losses).toBe(1)
    expect(t2Ranking.gameHistory).toEqual([
      {
        sessionID: SESSION_ID,
        gameID: GAME_ID,
        timestamp: Timestamp.fromMillis(NOW),
        previousMMR: 1000,
        mmrChange: -32,
        placement: 2,
        opponents: [{ playerID: "t1", mmr: 1000, placement: 1 }],
      },
    ])

    expect(gameWrite.kind).toBe("update")
    expect(gameWrite.path).toBe(GAME_PATH)
    expect(Object.keys(gameWrite.data).sort()).toEqual([
      "timeFinished",
      "turns",
    ])
    expect(
      (gameWrite.data.timeFinished as { methodName?: string }).methodName
    ).toBe("FieldValue.serverTimestamp")

    // The stored final turn carries the winners, enriched with MMR results.
    const finalTurn = arrayUnionTurn(gameWrite.data.turns)
    expect(finalTurn.winners).toEqual([
      {
        playerID: "t1",
        score: 3,
        winningSquares: [24, 23, 16],
        teamID: "t1",
        teamScore: 3,
        mmrChange: 32,
        newMMR: 1032,
      },
    ])
    expect(finalTurn.alivePlayers).toEqual(["t1"])

    expect(mockedCreateNewGame).toHaveBeenCalledTimes(1)
    expect(mockedCreateNewGame).toHaveBeenCalledWith(
      tx.asTransaction(),
      SESSION_ID,
      gameState.setup
    )

    // No next moveStatus for a finished game.
    expect(tx.writes.some((w) => w.path.includes("moveStatuses"))).toBe(false)
  })

  it("(v) applies each player's LAST staged move at or before the deadline and ignores later ones", async () => {
    const turn0 = mkTurn({ t1: [23, 16, 9], t2: [40, 39, 38] })
    const gameState = mkGameState(mkSetup(), [turn0])
    // endTime is 5000ms. t1 staged three moves: an early one, a later one
    // still inside the window, and one after the deadline. Delivery order is
    // deliberately shuffled to prove selection sorts by timestamp.
    const tx = mkTransaction(gameState, [
      mv("t1", 30, 4500), // last move inside the window -> applied
      mv("t2", 33, 2000),
      mv("t1", 24, 1000), // earlier move -> superseded
      mv("t1", 22, 6000), // after the deadline -> ignored
    ])

    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result.newTurnCreated).toBe(true)
    const nextTurn = arrayUnionTurn(tx.writes[0].data.turns)
    expect(nextTurn.moves).toEqual({ t1: 30, t2: 33 })
    expect(nextTurn.playerPieces).toEqual({
      t1: [30, 23, 16],
      t2: [33, 40, 39],
    })
    expect(nextTurn.alivePlayers).toEqual(["t1", "t2"])
  })
})
