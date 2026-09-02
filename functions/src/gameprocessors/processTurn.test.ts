// Characterization tests for processTurn(): pin the transaction read/write
// choreography exactly as production performs it today.
//
// The Firestore Transaction is replaced by a recorder whose get/update/create
// answers match the real call shapes (doc snapshots expose data/id/ref/exists,
// query snapshots expose docs[].id and docs[].data()). admin.firestore() is
// mocked to hand out path-carrying refs so writes can be asserted by path.

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
import { processTurn, selectLatestMoves } from "./processTurn"

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
    private queryDocs: Map<string, { id: string; data: unknown }[]>
  ) {}

  get(refOrQuery: FakeRef | FakeQuery): Promise<unknown> {
    if ("kind" in refOrQuery && refOrQuery.kind === "query") {
      this.queryCalls.push(refOrQuery)
      // Query snapshots expose both the id and the data of each document, and
      // arrive in the order the test listed them — Firestore, given only an
      // equality filter, delivers in __name__ order.
      const docs = (this.queryDocs.get(refOrQuery.path) ?? []).map((doc) => ({
        id: doc.id,
        data: () => doc.data,
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
    playerEnergy: Object.fromEntries(ids.map((id) => [id, 100])),
    startTime: Timestamp.fromMillis(0),
    endTime: Timestamp.fromMillis(5000),
    scores: Object.fromEntries(ids.map((id) => [id, playerPieces[id].length])),
    alivePlayers: ids,
    food: [],
    hazards: [],
    playerPieces,
    clashes: [],
    deaths: {},
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

/**
 * The same move staged at a sub-millisecond offset. Firestore commit
 * timestamps carry nanoseconds; two writes a fraction of a millisecond apart
 * are distinguishable, and `addDoc` gives each its own random document id.
 */
const mvAt = (
  playerID: string,
  move: number,
  atMillis: number,
  extraNanos: number
): Move => ({
  gameID: GAME_ID,
  moveNumber: 0,
  playerID,
  move,
  timestamp: new Timestamp(
    Math.floor(atMillis / 1000),
    (atMillis % 1000) * 1_000_000 + extraNanos
  ),
})

/** A staged privateMoves document: the id Firestore assigned it, plus a move. */
interface StagedDoc {
  id: string
  move: Move
}

const staged = (id: string, move: Move): StagedDoc => ({ id, move })

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
  moves: (Move | StagedDoc)[],
  rankings: { [teamID: string]: Ranking } = {}
): FakeTransaction => {
  const docs = new Map<string, unknown>([[GAME_PATH, gameState]])
  Object.entries(rankings).forEach(([teamID, ranking]) => {
    docs.set(`rankings/${teamID}`, ranking)
  })
  // Bare moves get synthesised ids in the order the test listed them; tests
  // that care which id a document has stage them explicitly.
  const stagedDocs = moves.map((m, i) =>
    "id" in m ? { id: m.id, data: m.move } : { id: `doc${i}`, data: m }
  )
  const queryDocs = new Map<string, { id: string; data: unknown }[]>([
    [`${GAME_PATH}/privateMoves`, stagedDocs],
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

// ---------------------------------------------------------------------------
// Staged-move selection: the contract a client stages against.
//
// A client that revises its move during a turn writes a NEW privateMoves
// document each time (the collection is append-only under firestore.rules —
// see centaurWire.spec.ts). Resolution therefore sees every revision and has
// to reduce them: per player, the newest write committed at or before the
// turn's endTime. These tests pin that reduction, including the orderings a
// batched multi-player writer runs into.
// ---------------------------------------------------------------------------

const END_TIME = Timestamp.fromMillis(5000)

describe("selectLatestMoves", () => {
  it("keeps each player's newest staged write and drops the superseded ones", () => {
    const chosen = selectLatestMoves(
      [
        staged("a", mv("t1", 24, 1000)),
        staged("b", mv("t2", 33, 1500)),
        staged("c", mv("t1", 30, 4500)),
        staged("d", mv("t1", 22, 2000)),
        staged("e", mv("t2", 34, 4000)),
      ],
      END_TIME
    )

    expect(chosen.map((m) => [m.playerID, m.move])).toEqual([
      ["t1", 30],
      ["t2", 34],
    ])
  })

  it("takes a write landing exactly on endTime and drops anything past it", () => {
    const chosen = selectLatestMoves(
      [
        staged("a", mv("t1", 24, 4999)),
        staged("b", mv("t1", 30, 5000)), // exactly endTime -> counts
        staged("c", mv("t1", 22, 5001)), // one millisecond late -> dropped
      ],
      END_TIME
    )

    expect(chosen).toHaveLength(1)
    expect(chosen[0].move).toBe(30)
  })

  it("counts a write landing inside the endTime millisecond — the deadline is compared in whole milliseconds", () => {
    // endTime is 5000ms exactly; both sides of the comparison floor to
    // milliseconds, so 5000.999999ms is still "at or before" the deadline.
    const chosen = selectLatestMoves(
      [
        staged("a", mv("t1", 24, 4000)),
        staged("b", mvAt("t1", 30, 5000, 999_999)),
      ],
      END_TIME
    )

    expect(chosen).toHaveLength(1)
    expect(chosen[0].move).toBe(30)
  })

  it("orders two revisions committed in the same millisecond by their nanoseconds, not by document id", () => {
    // The pair a client is most likely to produce: two revisions a fraction of
    // a millisecond apart. Both floor to the same millisecond, so only the
    // nanoseconds separate them — and the later write must win regardless of
    // which random document id Firestore handed each one.
    const earlier = mvAt("t1", 24, 3000, 100_000)
    const later = mvAt("t1", 30, 3000, 900_000)

    // Document id ascending agrees with write order...
    expect(
      selectLatestMoves(
        [staged("aaa", earlier), staged("zzz", later)],
        END_TIME
      )[0].move
    ).toBe(30)

    // ...and disagreeing with it changes nothing.
    expect(
      selectLatestMoves(
        [staged("aaa", later), staged("zzz", earlier)],
        END_TIME
      )[0].move
    ).toBe(30)
  })

  it("breaks an exactly-equal commit timestamp for one player deterministically on document id", () => {
    // Timestamps are only ever exactly equal when the two writes shared a
    // commit — one writeBatch — so neither is later and the winner is
    // arbitrary by nature. Pinned here so it is at least deterministic:
    // lowest document id, whichever order the query delivered them in.
    // Writing one document per player per batch keeps this unreachable.
    const atOnce = new Timestamp(3, 500_000)
    const first = { ...mv("t1", 24, 0), timestamp: atOnce }
    const second = { ...mv("t1", 30, 0), timestamp: atOnce }

    expect(
      selectLatestMoves(
        [staged("aaa", first), staged("zzz", second)],
        END_TIME
      )[0].move
    ).toBe(24)
    expect(
      selectLatestMoves(
        [staged("zzz", second), staged("aaa", first)],
        END_TIME
      )[0].move
    ).toBe(24)
  })

  it("applies every player's move from one batch sharing a single commit timestamp", () => {
    // One writeBatch per team per revision, one document per player: all three
    // documents carry the identical serverTimestamp, and all three count.
    const atOnce = new Timestamp(4, 250_000)
    const chosen = selectLatestMoves(
      ["t1", "t2", "t3"].map((id, i) =>
        staged(`batch${i}`, { ...mv(id, 20 + i, 0), timestamp: atOnce })
      ),
      END_TIME
    )

    expect(chosen.map((m) => [m.playerID, m.move]).sort()).toEqual([
      ["t1", 20],
      ["t2", 21],
      ["t3", 22],
    ])
  })

  it("lets a later batch supersede an earlier one for every player at once", () => {
    const firstBatch = new Timestamp(2, 0)
    const secondBatch = new Timestamp(2, 400_000) // same millisecond, later
    const chosen = selectLatestMoves(
      [
        staged("a0", { ...mv("t1", 10, 0), timestamp: firstBatch }),
        staged("a1", { ...mv("t2", 11, 0), timestamp: firstBatch }),
        staged("b0", { ...mv("t1", 20, 0), timestamp: secondBatch }),
        staged("b1", { ...mv("t2", 21, 0), timestamp: secondBatch }),
      ],
      END_TIME
    )

    expect(chosen.map((m) => [m.playerID, m.move]).sort()).toEqual([
      ["t1", 20],
      ["t2", 21],
    ])
  })

  it("omits a player who staged nothing, and one whose only write was late", () => {
    const chosen = selectLatestMoves(
      [staged("a", mv("t1", 24, 1000)), staged("b", mv("t2", 33, 9000))],
      END_TIME
    )

    expect(chosen.map((m) => m.playerID)).toEqual(["t1"])
  })

  it("treats a write with no usable timestamp as the epoch: it never wins, and never misses the deadline", () => {
    const noTimestamp = { ...mv("t1", 24, 0), timestamp: undefined as never }

    // Alone, it is still applied.
    expect(selectLatestMoves([staged("a", noTimestamp)], END_TIME)).toEqual([
      noTimestamp,
    ])
    // Against any timestamped write from the same player, it loses.
    expect(
      selectLatestMoves(
        [staged("a", noTimestamp), staged("b", mv("t1", 30, 1))],
        END_TIME
      )[0].move
    ).toBe(30)
  })
})

describe("processTurn staged-move acceptance", () => {
  it("(vi) applies every move of a batch that shares one commit timestamp", async () => {
    // The wire-level shape of a team submitting through one writeBatch.
    const turn0 = mkTurn({ t1: [23, 16, 9], t2: [40, 39, 38] })
    const gameState = mkGameState(mkSetup(), [turn0])
    const atOnce = new Timestamp(4, 123_456)
    const tx = mkTransaction(gameState, [
      staged("batch0", { ...mv("t1", 24, 0), timestamp: atOnce }),
      staged("batch1", { ...mv("t2", 33, 0), timestamp: atOnce }),
    ])

    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result.newTurnCreated).toBe(true)
    const nextTurn = arrayUnionTurn(tx.writes[0].data.turns)
    expect(nextTurn.moves).toEqual({ t1: 24, t2: 33 })
    expect(nextTurn.alivePlayers).toEqual(["t1", "t2"])
  })

  it("(vii) substitutes the default action for a player who staged nothing", async () => {
    // Resolution never waits for a missing move: an unstaged unit takes its
    // kind's default (a snake continues one step along its orientation). The
    // engine-level cases live in TeamSnekProcessor.spec.ts; this pins that a
    // PARTIALLY staged turn resolves the same way through processTurn.
    const turn0 = mkTurn(
      { t1: [23, 16, 9], t2: [40, 39, 38] },
      { orientation: { t1: { dx: 1, dy: 0 }, t2: { dx: 0, dy: -1 } } }
    )
    const gameState = mkGameState(mkSetup(), [turn0])
    const tx = mkTransaction(gameState, [mv("t1", 24, 1000)])

    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result.newTurnCreated).toBe(true)
    const nextTurn = arrayUnionTurn(tx.writes[0].data.turns)
    // t2 staged nothing and still moved: head 40 -> 33, one step "up".
    expect(nextTurn.moves).toEqual({ t1: 24, t2: 33 })
    expect(nextTurn.playerPieces).toEqual({
      t1: [24, 23, 16],
      t2: [33, 40, 39],
    })
    expect(nextTurn.alivePlayers).toEqual(["t1", "t2"])
  })

  it("(viii) ignores a revision committed after endTime, however the write was accepted", async () => {
    const turn0 = mkTurn({ t1: [23, 16, 9], t2: [40, 39, 38] })
    const gameState = mkGameState(mkSetup(), [turn0])
    // turn0's endTime is 5000ms. t1's last revision lands a millisecond late.
    const tx = mkTransaction(gameState, [
      mv("t1", 24, 4900),
      mv("t2", 33, 2000),
      mv("t1", 30, 5001),
    ])

    const result = await processTurn(tx.asTransaction(), GAME_ID, SESSION_ID, 0)

    expect(result.newTurnCreated).toBe(true)
    const nextTurn = arrayUnionTurn(tx.writes[0].data.turns)
    expect(nextTurn.moves).toEqual({ t1: 24, t2: 33 })
  })
})
