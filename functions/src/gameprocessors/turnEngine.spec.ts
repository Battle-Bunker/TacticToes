// The unified turn engine, at spec level. Everything here exercises rules the
// engine owns for EVERY game: frozen tier/weight, the sub-step loop, persistent
// collision objects (the wrestling rule), severs that keep blocking until the
// turn ends, per-sub-step health, and the typed wire the engine emits.
//
// Several of these deliberately INVERT behavior the old two-engine fork pinned.
// Each inversion is called out where it lives.

import { Timestamp } from "firebase-admin/firestore"
import {
  GamePlayer,
  GameState,
  Move,
  StartedGameSetup,
  Team,
  Turn,
} from "@shared/types/Game"
import { TeamSnekProcessor } from "./TeamSnekProcessor"
import { REASON } from "./engine/turnEngine"

// 11x11 board: index = y * 11 + x, perimeter is wall (interior 1..9).
const W = 11
const at = (x: number, y: number): number => y * W + x

const teams = (...ids: string[]): Team[] =>
  ids.map((id) => ({ id, name: id, color: "#ff0000" }))

const gp = (
  id: string,
  teamID: string,
  letter: string,
  unitType: GamePlayer["unitType"]
): GamePlayer => ({ id, teamID, letter, unitType })

const mv = (playerID: string, move: number): Move => ({
  gameID: "game1",
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(0),
})

/** N copies of one cell: a piece's weight-stack. */
const stack = (cell: number, weight: number): number[] => Array(weight).fill(cell)

interface Scenario {
  players: GamePlayer[]
  pieces: { [playerID: string]: number[] }
  moves: Move[]
  turn?: Partial<Turn>
  setup?: Partial<StartedGameSetup>
  turnsBefore?: number
}

const play = (scenario: Scenario): Turn => {
  const ids = Object.keys(scenario.pieces)
  const teamIDs = Array.from(new Set(scenario.players.map((p) => p.teamID)))
  const turn: Turn = {
    playerHealth: Object.fromEntries(ids.map((id) => [id, 100])),
    startTime: Timestamp.fromMillis(0),
    endTime: Timestamp.fromMillis(5000),
    scores: Object.fromEntries(ids.map((id) => [id, scenario.pieces[id].length])),
    alivePlayers: ids,
    food: [],
    hazards: [],
    playerPieces: scenario.pieces,
    clashes: [],
    deaths: {},
    moves: {},
    winners: [],
    unitTypes: Object.fromEntries(
      scenario.players.map((p) => [p.id, p.unitType ?? "snake"])
    ),
    ...scenario.turn,
    orientation: {
      ...Object.fromEntries(ids.map((id) => [id, { dx: 1, dy: 0 }])),
      ...scenario.turn?.orientation,
    },
  }
  const setup: StartedGameSetup = {
    teams: teams(...teamIDs),
    snakesPerTeam: 1,
    gamePlayers: scenario.players,
    boardWidth: W,
    boardHeight: W,
    maxTurnTime: 5,
    startRequested: false,
    started: true,
    timeCreated: Timestamp.fromMillis(0),
    foodSpawnRate: 0,
    ...scenario.setup,
  }
  const gameState: GameState = {
    setup,
    turns: Array(scenario.turnsBefore ?? 1).fill(turn),
    walls: [],
    timeCreated: Timestamp.fromMillis(0),
    timeFinished: null,
  }
  return new TeamSnekProcessor(gameState).applyMoves(turn, scenario.moves)
}

/** Turn state with every keyed map sorted, so key order cannot mask a diff. */
const normalize = (turn: Turn): string => {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === "object" && !(value instanceof Timestamp)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => [k, sortKeys(v)])
      )
    }
    return value
  }
  return JSON.stringify(
    sortKeys({
      alivePlayers: [...turn.alivePlayers].sort(),
      playerPieces: turn.playerPieces,
      playerHealth: turn.playerHealth,
      scores: turn.scores,
      teamScores: turn.teamScores,
      moves: turn.moves,
      deaths: turn.deaths,
      severedCells: turn.severedCells,
      paths: turn.paths,
      orientation: turn.orientation,
      clashes: turn.clashes,
    })
  )
}

/** Every rotation of the roster (and of the piece map, which follows it). */
const permutations = (scenario: Scenario): Scenario[] =>
  scenario.players.map((_, offset) => {
    const players = [
      ...scenario.players.slice(offset),
      ...scenario.players.slice(0, offset),
    ]
    const pieces: { [playerID: string]: number[] } = {}
    players.forEach((p) => {
      pieces[p.id] = scenario.pieces[p.id]
    })
    return { ...scenario, players, pieces, moves: [...scenario.moves].reverse() }
  })

const agreesUnderPermutation = (scenario: Scenario): void => {
  const outcomes = permutations(scenario).map((s) => normalize(play(s)))
  outcomes.forEach((outcome) => expect(outcome).toBe(outcomes[0]))
}

describe("frozen state: nothing leaves the board mid-turn", () => {
  // INVERTED. The old engines removed a dead unit the instant it died, so its
  // cell was free for anything arriving later in the same turn. Corpses now
  // persist as collision objects for the whole collision phase.
  //
  // Two equal-weight kings annihilate each other on (5,5) at sub-step 1. A
  // light rook reaches the pile at sub-step 3 and is crushed by it; a heavy
  // rook reaches the same pile at sub-step 4, out-masses the entire pile, and
  // capture-stops on it.
  const corpsePile = (): Turn =>
    play({
      players: [
        gp("k1", "t1", "A", "rook"),
        gp("k2", "t2", "A", "rook"),
        gp("light", "t1", "B", "rook"),
        gp("heavy", "t2", "B", "rook"),
      ],
      pieces: {
        k1: stack(at(4, 5), 4),
        k2: stack(at(6, 5), 4),
        light: stack(at(2, 5), 3),
        heavy: stack(at(9, 5), 6),
      },
      moves: [
        mv("k1", at(5, 5)),
        mv("k2", at(5, 5)),
        mv("light", at(9, 5)),
        mv("heavy", at(1, 5)),
      ],
    })

  it("equal heavies annihilate, a lighter later arrival joins the pile, a heavier one wins it", () => {
    const next = corpsePile()
    const x = at(5, 5)

    expect(next.alivePlayers).toEqual(["heavy"])
    expect(next.playerPieces.heavy).toEqual(stack(x, 6))
    // It stopped ON the pile: the rest of its ray is abandoned.
    expect(next.paths?.heavy).toEqual([at(8, 5), at(7, 5), at(6, 5), x])
    expect(next.playerHealth.heavy).toBe(96)

    expect(next.deaths).toEqual({
      k1: { cell: x, subStep: 1, cause: "contest" },
      k2: { cell: x, subStep: 1, cause: "contest" },
      light: { cell: x, subStep: 3, cause: "contest" },
    })
  })

  it("each sub-step's contest names the whole pile, and only that sub-step's victims", () => {
    const next = corpsePile()
    const x = at(5, 5)
    const atCell = next.clashes.filter((c) => c.index === x)

    expect(atCell.map((c) => c.subStep)).toEqual([1, 3, 4])

    expect(atCell[0]).toMatchObject({
      kind: "contest",
      playerIDs: ["k1", "k2"],
      victimIDs: ["k1", "k2"],
      reason: REASON.tie,
    })
    expect(atCell[0].survivorID).toBeUndefined()

    // The lighter arrival is judged against BOTH corpses at once.
    expect(atCell[1]).toMatchObject({
      kind: "contest",
      playerIDs: ["k1", "k2", "light"],
      victimIDs: ["light"],
    })
    expect(atCell[1].survivorID).toBeUndefined()

    // The heavy rook out-masses the whole accumulated pile and survives it.
    expect(atCell[2]).toMatchObject({
      kind: "contest",
      playerIDs: ["heavy", "k1", "k2", "light"],
      victimIDs: [],
      survivorID: "heavy",
      reason: REASON.weight,
    })
  })

  it("a unit that crossed the cell BEFORE the first death there is untouched", () => {
    // The bishop crosses (5,5) at sub-step 3; the kings only die there at
    // sub-step 4, well after it has gone.
    const next = play({
      players: [
        gp("b", "t3", "A", "bishop"),
        gp("k1", "t1", "A", "rook"),
        gp("k2", "t2", "A", "rook"),
      ],
      pieces: { b: [at(2, 2)], k1: [at(5, 8)], k2: [at(5, 6)] },
      moves: [mv("b", at(8, 8)), mv("k1", at(5, 7)), mv("k2", at(5, 7))],
    })

    expect(next.alivePlayers).toEqual(["b"])
    expect(next.playerPieces.b).toEqual([at(8, 8)])
    expect(next.deaths.k1.cell).toBe(at(5, 7))
    expect(next.deaths.k2.cell).toBe(at(5, 7))
  })
})

describe("starvation is a death like any other", () => {
  // A rook with 2 health and a stack of 3 starves on the second cell of its
  // ray and STAYS there as an incumbent — a dying animal that still beats a
  // lighter arrival on frozen weight, and still loses to a heavier one.
  const starvedIncumbent = (challengerWeight: number): Turn =>
    play({
      players: [gp("dying", "t1", "A", "rook"), gp("comer", "t2", "A", "rook")],
      pieces: {
        dying: stack(at(1, 5), 3),
        comer: stack(at(7, 5), challengerWeight),
      },
      moves: [mv("dying", at(9, 5)), mv("comer", at(1, 5))],
      turn: { playerHealth: { dying: 2, comer: 100 } },
    })

  it("halts where its health ran out and is recorded as starved", () => {
    const next = starvedIncumbent(5)
    expect(next.deaths.dying).toEqual({
      cell: at(3, 5),
      subStep: 2,
      cause: "starvation",
    })
    expect(next.moves.dying).toBe(at(3, 5))
    expect(next.paths?.dying).toEqual([at(2, 5), at(3, 5)])
    expect(
      next.clashes.some((c) => c.index === at(3, 5) && c.reason === REASON.starvation)
    ).toBe(true)
  })

  it("still defeats a lighter arrival two sub-steps after it died", () => {
    const next = starvedIncumbent(2)
    expect(next.alivePlayers).toEqual([])
    expect(next.deaths.comer).toEqual({
      cell: at(3, 5),
      subStep: 4,
      cause: "contest",
    })
  })

  it("loses to a heavier arrival, which capture-stops on the corpse", () => {
    const next = starvedIncumbent(5)
    expect(next.alivePlayers).toEqual(["comer"])
    expect(next.playerPieces.comer).toEqual(stack(at(3, 5), 5))
    expect(next.paths?.comer).toEqual([at(6, 5), at(5, 5), at(4, 5), at(3, 5)])
    expect(next.playerHealth.comer).toBe(96)
  })

  // INVERTED. Movement cost used to be settled once, in the food phase, where
  // eating replaced it outright — so food could rescue a unit that could not
  // afford the trip. The engine charges each cell as it is entered, so the
  // unit dies before it can arrive and the food stays on the board.
  it("food no longer rescues a unit that cannot afford the ray", () => {
    const next = play({
      players: [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")],
      pieces: { t1: [at(1, 5)], t2: [at(9, 9)] },
      moves: [mv("t1", at(5, 5))],
      turn: { food: [at(5, 5)], playerHealth: { t1: 2, t2: 100 } },
    })

    expect(next.alivePlayers).toEqual(["t2"])
    expect(next.deaths.t1).toEqual({ cell: at(3, 5), subStep: 2, cause: "starvation" })
    expect(next.food).toEqual([at(5, 5)])
  })

  it("the same holds for a trail unit stepping onto food at 1 health", () => {
    const next = play({
      players: [gp("s1", "t1", "A", "snake"), gp("s2", "t2", "A", "snake")],
      pieces: { s1: [at(4, 5), at(3, 5), at(2, 5)], s2: [at(8, 8), at(8, 7), at(8, 6)] },
      moves: [mv("s1", at(5, 5)), mv("s2", at(8, 9))],
      turn: { food: [at(5, 5)], playerHealth: { s1: 1, s2: 100 } },
    })

    expect(next.alivePlayers).toEqual(["s2"])
    expect(next.deaths.s1).toEqual({ cell: at(5, 5), subStep: 1, cause: "starvation" })
    expect(next.food).toEqual([at(5, 5)])
  })

  it("a hazard that drains a unit to zero is recorded as a hazard death, not starvation", () => {
    const next = play({
      players: [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")],
      pieces: { t1: [at(1, 5)], t2: [at(9, 9)] },
      moves: [mv("t1", at(9, 5))],
      turn: { hazards: [at(4, 5)], playerHealth: { t1: 20, t2: 100 } },
      setup: { hazardDamage: 30 },
    })

    expect(next.deaths.t1).toEqual({ cell: at(4, 5), subStep: 3, cause: "hazard" })
  })
})

describe("severs: the cut lands only when the turn is over", () => {
  // The snake's post-move body is [(5,2),(5,3),(5,4),(5,5),(5,6)].
  const severedSnake = {
    body: [at(5, 3), at(5, 4), at(5, 5), at(5, 6), at(5, 7)],
    head: at(5, 2),
  }

  it("a severed segment still blocks a later arrival, and the truncation shows only at end of turn", () => {
    const next = play({
      players: [
        gp("s", "t1", "A", "snake"),
        gp("cutter", "t2", "A", "rook"),
        gp("late", "t2", "B", "rook"),
      ],
      pieces: { s: severedSnake.body, cutter: [at(3, 3)], late: [at(1, 6)] },
      moves: [mv("s", severedSnake.head), mv("cutter", at(9, 3)), mv("late", at(9, 6))],
      turn: { playerInvulnerabilityLevel: { s: 0, cutter: 1, late: 0 } },
    })

    // The cutter bites at (5,3) on sub-step 2 and capture-stops there.
    expect(next.playerPieces.cutter).toEqual([at(5, 3)])
    const sever = next.clashes.find((c) => c.kind === "sever")
    expect(sever).toMatchObject({
      index: at(5, 3),
      subStep: 2,
      playerIDs: ["cutter", "s"],
      victimIDs: [],
      survivorID: "cutter",
      reason: REASON.sever,
    })

    // (5,6) is inside the severed run, and it STILL kills the rook that
    // reaches it on sub-step 4 — the cut is not applied until the turn ends.
    expect(next.deaths.late).toEqual({ cell: at(5, 6), subStep: 4, cause: "bodyBlock" })
    expect(
      next.clashes.some((c) => c.index === at(5, 6) && c.kind === "bodyBlock")
    ).toBe(true)

    // Only now: the snake is truncated, and the cut cells go on the wire.
    expect(next.alivePlayers.sort()).toEqual(["cutter", "s"])
    expect(next.playerPieces.s).toEqual([severedSnake.head])
    expect(next.severedCells).toEqual({
      s: [at(5, 3), at(5, 4), at(5, 5), at(5, 6)],
    })
  })

  it("two severs on one owner: the lowest cut wins, and both severers capture-stop", () => {
    // Both rooks bite on the same sub-step, at segments 3 and 1. Whichever
    // order the roster puts them in, the deeper bite is the one that lands.
    const next = play({
      players: [
        gp("s", "t1", "A", "snake"),
        gp("deep", "t2", "A", "rook"),
        gp("shallow", "t2", "B", "rook"),
      ],
      pieces: { s: severedSnake.body, deep: [at(1, 3)], shallow: [at(1, 5)] },
      moves: [mv("s", severedSnake.head), mv("deep", at(9, 3)), mv("shallow", at(9, 5))],
      turn: { playerInvulnerabilityLevel: { s: 0, deep: 1, shallow: 1 } },
    })

    expect(next.clashes.filter((c) => c.kind === "sever")).toHaveLength(2)
    expect(next.playerPieces.deep).toEqual([at(5, 3)])
    expect(next.playerPieces.shallow).toEqual([at(5, 5)])
    expect(next.playerPieces.s).toEqual([severedSnake.head])
    expect(next.severedCells).toEqual({
      s: [at(5, 3), at(5, 4), at(5, 5), at(5, 6)],
    })
  })

  it("a severed owner fights the rest of the turn at its frozen start-of-turn weight", () => {
    // The snake starts at weight 4 and is cut down to 2. A weight-3 rook
    // reaches its head two sub-steps after the cut: judged on the frozen 4 the
    // rook loses; judged on the live 2 it would have won.
    const next = play({
      players: [
        gp("s", "t1", "A", "snake"),
        gp("cutter", "t2", "A", "rook"),
        gp("comer", "t3", "A", "rook"),
      ],
      pieces: {
        s: [at(5, 3), at(5, 4), at(5, 5), at(5, 6)],
        cutter: [at(3, 4)],
        comer: stack(at(1, 2), 3),
      },
      moves: [mv("s", at(5, 2)), mv("cutter", at(9, 4)), mv("comer", at(9, 2))],
      turn: { playerInvulnerabilityLevel: { s: 0, cutter: 1, comer: 0 } },
    })

    expect(next.alivePlayers.sort()).toEqual(["cutter", "s"])
    expect(next.playerPieces.s).toEqual([at(5, 2), at(5, 3)]) // cut to weight 2
    expect(next.severedCells).toEqual({ s: [at(5, 4), at(5, 5)] })
    expect(next.deaths.comer).toEqual({ cell: at(5, 2), subStep: 4, cause: "contest" })
  })

  it("severing a vulnerable owner expires its allies' buffs, exactly as killing it does", () => {
    // Parity fix: on the old chess path a piece could sever a debuffed snake
    // without ever expiring the team's ally buffs. Now one encoding covers
    // deaths AND surviving severed owners.
    const next = play({
      players: [
        gp("s", "t1", "A", "snake"),
        gp("ally", "t1", "B", "bishop"),
        gp("cutter", "t2", "A", "rook"),
      ],
      pieces: {
        s: [at(5, 3), at(5, 4), at(5, 5), at(5, 6)],
        ally: [at(1, 1)],
        cutter: [at(1, 5)],
      },
      moves: [mv("s", at(5, 2)), mv("cutter", at(9, 5))],
      turn: {
        playerInvulnerabilityLevel: { s: -1, ally: 1, cutter: 0 },
        activeEffects: [
          {
            playerID: "s",
            type: "invulnerability_debuff",
            level: -1,
            expiryTurn: 3,
            sourcePlayerID: "s",
          },
          {
            playerID: "ally",
            type: "invulnerability_buff",
            level: 1,
            expiryTurn: 3,
            sourcePlayerID: "s",
          },
        ],
      },
      setup: { invulnerabilityPotionEnabled: true, invulnerabilityPotionSpawnRate: 0 },
    })

    expect(next.clashes.some((c) => c.kind === "sever")).toBe(true)
    expect(next.alivePlayers.sort()).toEqual(["ally", "cutter", "s"])
    expect(next.playerInvulnerabilityLevel).toEqual({ s: -1, ally: 0, cutter: 0 })
    expect(next.activeEffects).toEqual([
      {
        playerID: "s",
        type: "invulnerability_debuff",
        level: -1,
        expiryTurn: 3,
        sourcePlayerID: "s",
      },
    ])
  })
})

describe("snake-only games run the same engine", () => {
  const bystanders = {
    sb1: [at(2, 2), at(2, 3), at(2, 4)],
    sb2: [at(8, 8), at(8, 7), at(8, 6)],
  }
  const bystanderMoves = [mv("sb1", at(3, 2)), mv("sb2", at(9, 8))]

  // INVERTED. The old single-pass snake engine had no edge rule at all: two
  // length-1 snakes trading cells slid straight through one another. Length-1
  // snakes are reachable in ordinary play — severing bottoms out there.
  it("two length-1 snakes trading cells now contest the edge and both die", () => {
    const next = play({
      players: [
        gp("s1", "t1", "A", "snake"),
        gp("s2", "t2", "A", "snake"),
        gp("sb1", "t1", "B", "snake"),
        gp("sb2", "t2", "B", "snake"),
      ],
      pieces: { s1: [at(5, 5)], s2: [at(6, 5)], ...bystanders },
      moves: [mv("s1", at(6, 5)), mv("s2", at(5, 5)), ...bystanderMoves],
    })

    expect(next.alivePlayers.sort()).toEqual(["sb1", "sb2"])
    expect(next.deaths.s1).toEqual({ cell: at(5, 5), subStep: 1, cause: "edge" })
    expect(next.deaths.s2).toEqual({ cell: at(6, 5), subStep: 1, cause: "edge" })
    expect(next.moves.s1).toBe(at(5, 5))
    expect(next.moves.s2).toBe(at(6, 5))
    // Piece-only wire fields stay off in a snake-only game.
    expect(next.unitTypes).toBeUndefined()
    expect(next.paths).toBeUndefined()
  })

  it("the higher tier wins the edge and completes into the loser's cell", () => {
    const next = play({
      players: [
        gp("s1", "t1", "A", "snake"),
        gp("s2", "t2", "A", "snake"),
        gp("sb1", "t1", "B", "snake"),
        gp("sb2", "t2", "B", "snake"),
      ],
      pieces: { s1: [at(5, 5)], s2: [at(6, 5)], ...bystanders },
      moves: [mv("s1", at(6, 5)), mv("s2", at(5, 5)), ...bystanderMoves],
      turn: { playerInvulnerabilityLevel: { s1: 1, s2: 0, sb1: 0, sb2: 0 } },
    })

    expect(next.alivePlayers.sort()).toEqual(["s1", "sb1", "sb2"])
    expect(next.playerPieces.s1).toEqual([at(6, 5)])
    expect(next.deaths.s2).toEqual({ cell: at(6, 5), subStep: 1, cause: "edge" })
    const clash = next.clashes.find((c) => c.kind === "edge")
    expect(clash).toMatchObject({
      index: at(6, 5),
      playerIDs: ["s1", "s2"],
      victimIDs: ["s2"],
      survivorID: "s1",
      reason: REASON.tier,
    })
  })

  it("a longer snake is still exempt: its swept-in body resolves the meeting", () => {
    const next = play({
      players: [
        gp("s1", "t1", "A", "snake"),
        gp("s2", "t2", "A", "snake"),
        gp("sb1", "t1", "B", "snake"),
        gp("sb2", "t2", "B", "snake"),
      ],
      pieces: { s1: [at(5, 5), at(4, 5)], s2: [at(6, 5), at(7, 5)], ...bystanders },
      moves: [mv("s1", at(6, 5)), mv("s2", at(5, 5)), ...bystanderMoves],
    })

    // Both meet a body segment rather than an edge: equal tier, so both die on
    // the segment they ran into.
    expect(next.alivePlayers.sort()).toEqual(["sb1", "sb2"])
    expect(next.deaths.s1.cause).toBe("bodyBlock")
    expect(next.deaths.s2.cause).toBe("bodyBlock")
  })
})

describe("the wire the engine emits", () => {
  it("carries deaths, severedCells and typed clash records", () => {
    const next = play({
      players: [
        gp("s", "t1", "A", "snake"),
        gp("cutter", "t2", "A", "rook"),
        gp("victim", "t2", "B", "rook"),
      ],
      pieces: {
        s: [at(5, 3), at(5, 4), at(5, 5), at(5, 6)],
        cutter: [at(1, 4)],
        victim: [at(4, 2)],
      },
      moves: [mv("s", at(5, 2)), mv("cutter", at(9, 4)), mv("victim", at(5, 2))],
      turn: { playerInvulnerabilityLevel: { s: 0, cutter: 1, victim: 0 } },
    })

    // The king walks onto the snake's new head and loses on weight.
    expect(next.deaths).toEqual({
      victim: { cell: at(5, 2), subStep: 1, cause: "contest" },
    })
    expect(next.severedCells).toEqual({ s: [at(5, 4), at(5, 5)] })

    next.clashes.forEach((clash) => {
      expect(typeof clash.index).toBe("number")
      expect(typeof clash.subStep).toBe("number")
      expect(typeof clash.kind).toBe("string")
      expect(Array.isArray(clash.playerIDs)).toBe(true)
      expect(Array.isArray(clash.victimIDs)).toBe(true)
      // Victims are always a subset of the units the record names.
      clash.victimIDs.forEach((id) => expect(clash.playerIDs).toContain(id))
      if (clash.survivorID) expect(clash.playerIDs).toContain(clash.survivorID)
    })

    // Every dead unit's applied move is the cell it died on.
    Object.entries(next.deaths).forEach(([id, death]) => {
      expect(next.moves[id]).toBe(death.cell)
    })
  })

  it("drops severedCells from a turn where nothing was cut", () => {
    const next = play({
      players: [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")],
      pieces: { t1: [at(1, 5)], t2: [at(9, 9)] },
      moves: [mv("t1", at(4, 5))],
    })

    expect(next.severedCells).toBeUndefined()
    expect(next.deaths).toEqual({})
  })
})

describe("pawn rotation is signalling, not movement", () => {
  // The interior-bounds check used to reject the staged square before the
  // grammar ever reached the rotation branch, so a pawn backed against a wall
  // silently lost the ability to turn that way. Rotation never enters the
  // square, so it is legal wherever the side square falls.
  it("a pawn against the wall may still rotate toward it", () => {
    const next = play({
      players: [gp("p", "t1", "A", "pawn"), gp("k", "t2", "A", "king")],
      pieces: { p: [at(1, 5)], k: [at(8, 8)] },
      moves: [mv("p", at(0, 5))], // the side square is on the perimeter wall
      turn: { orientation: { p: { dx: 0, dy: 1 }, k: { dx: 1, dy: 0 } } },
    })

    expect(next.orientation.p).toEqual({ dx: -1, dy: 0 })
    expect(next.playerPieces.p).toEqual([at(1, 5)])
    expect(next.moves.p).toBe(at(1, 5))
    expect(next.playerHealth.p).toBe(100)
  })

  it("but a pawn still may not STEP into a wall", () => {
    const next = play({
      players: [gp("p", "t1", "A", "pawn"), gp("k", "t2", "A", "king")],
      pieces: { p: [at(1, 5)], k: [at(8, 8)] },
      moves: [mv("p", at(0, 5))], // now the forward square: illegal, so it holds
      turn: { orientation: { p: { dx: -1, dy: 0 }, k: { dx: 1, dy: 0 } } },
    })

    expect(next.playerPieces.p).toEqual([at(1, 5)])
    expect(next.orientation.p).toEqual({ dx: -1, dy: 0 })
    expect(next.playerHealth.p).toBe(100)
  })
})

// Every adjudication reads the post-advance snapshot and the frozen
// tier/weight only, so the turn cannot depend on the order units happen to sit
// in the roster. Both scenarios below raced under the old engines: one on when
// a dead body vacated its cell, the other on whose sever landed first.
describe("determinism under roster permutation", () => {
  it("the dead-body race: who reaches a corpse first cannot change the result", () => {
    agreesUnderPermutation({
      players: [
        gp("k1", "t1", "A", "rook"),
        gp("k2", "t2", "A", "rook"),
        gp("light", "t1", "B", "rook"),
        gp("heavy", "t2", "B", "rook"),
      ],
      pieces: {
        k1: stack(at(4, 5), 4),
        k2: stack(at(6, 5), 4),
        light: stack(at(2, 5), 3),
        heavy: stack(at(9, 5), 6),
      },
      moves: [
        mv("k1", at(5, 5)),
        mv("k2", at(5, 5)),
        mv("light", at(9, 5)),
        mv("heavy", at(1, 5)),
      ],
    })
  })

  it("the mid-loop sever race: two heads on two segments of one snake", () => {
    agreesUnderPermutation({
      players: [
        gp("s", "t1", "A", "snake"),
        gp("deep", "t2", "A", "rook"),
        gp("shallow", "t2", "B", "rook"),
        gp("comer", "t3", "A", "rook"),
      ],
      pieces: {
        s: [at(5, 3), at(5, 4), at(5, 5), at(5, 6), at(5, 7)],
        deep: [at(1, 3)],
        shallow: [at(1, 5)],
        comer: stack(at(1, 2), 4),
      },
      moves: [
        mv("s", at(5, 2)),
        mv("deep", at(9, 3)),
        mv("shallow", at(9, 5)),
        mv("comer", at(9, 2)),
      ],
      turn: {
        playerInvulnerabilityLevel: { s: 0, deep: 1, shallow: 1, comer: 0 },
      },
    })
  })
})

// CHARACTERIZATION, not new rules. Off-parity snakes — spawned on opposite
// square colours — have heads that can meet through an EDGE but can never
// co-arrive on one cell. The legacy engine had no rule for a snake-vs-snake
// edge meeting at all: the two heads simply passed through each other. Under
// the unified engine these all fall out of the general rules, and this block
// pins what the general rules actually produce.
describe("off-parity snakes", () => {
  const bystanders = {
    sb1: [at(2, 2), at(2, 3), at(2, 4)],
    sb2: [at(8, 8), at(8, 7), at(8, 6)],
  }
  const bystanderMoves = [mv("sb1", at(3, 2)), mv("sb2", at(9, 8))]
  const bystanderPlayers = [
    gp("sb1", "t3", "A", "snake"),
    gp("sb2", "t4", "A", "snake"),
  ]

  /** s1 sits on (5,5), s2 on (6,5): adjacent heads, one shared edge. */
  const faceOff = (
    s1Body: number[],
    s2Body: number[],
    s2Target: number,
    turn: Partial<Turn> = {},
    setup: Partial<StartedGameSetup> = {}
  ): Turn =>
    play({
      players: [
        gp("s1", "t1", "A", "snake"),
        gp("s2", "t2", "A", "snake"),
        ...bystanderPlayers,
      ],
      pieces: { s1: s1Body, s2: s2Body, ...bystanders },
      moves: [mv("s1", at(6, 5)), mv("s2", s2Target), ...bystanderMoves],
      turn,
      setup,
    })

  // 1. Neither snake contests the edge: each one's neck sweeps into the cell
  // it came from, so each head lands on the OTHER's neck and the body rules
  // decide. At equal tier that is mutual annihilation, one cell each.
  it("(1) equal tier, both length 2: each dies on the other's neck", () => {
    const next = faceOff([at(5, 5), at(4, 5)], [at(6, 5), at(7, 5)], at(5, 5))

    expect(next.alivePlayers.sort()).toEqual(["sb1", "sb2"])
    expect(next.deaths).toEqual({
      s1: { cell: at(6, 5), subStep: 1, cause: "bodyBlock" },
      s2: { cell: at(5, 5), subStep: 1, cause: "bodyBlock" },
    })
    // One record per cell, each naming both units and its own victim. Neither
    // record claims a survivor: they condemned each other simultaneously.
    const [onFive, onSix] = next.clashes.filter((c) => c.kind === "bodyBlock")
    expect(onFive).toMatchObject({
      index: at(5, 5),
      playerIDs: ["s1", "s2"],
      victimIDs: ["s2"],
    })
    expect(onSix).toMatchObject({
      index: at(6, 5),
      playerIDs: ["s1", "s2"],
      victimIDs: ["s1"],
    })
    expect(onFive.survivorID).toBeUndefined()
    expect(onSix.survivorID).toBeUndefined()
    // Both corpses stay put as collision objects for the rest of the turn.
    expect(next.moves.s1).toBe(at(6, 5))
    expect(next.moves.s2).toBe(at(5, 5))
  })

  // 2. Asymmetric, and deliberately so: the length-1 snake vacates completely,
  // so the longer snake walks into an empty cell — while the length-1 snake
  // walks into the neck the longer one just swept in.
  it("(2) length 2 vs length 1: only the length-1 snake dies, on its own destination", () => {
    const next = faceOff([at(5, 5), at(4, 5)], [at(6, 5)], at(5, 5))

    expect(next.alivePlayers.sort()).toEqual(["s1", "sb1", "sb2"])
    expect(next.playerPieces.s1).toEqual([at(6, 5), at(5, 5)]) // completed the step
    expect(next.deaths).toEqual({
      s2: { cell: at(5, 5), subStep: 1, cause: "bodyBlock" },
    })
    expect(next.clashes.find((c) => c.kind === "bodyBlock")).toMatchObject({
      index: at(5, 5),
      playerIDs: ["s1", "s2"],
      victimIDs: ["s2"],
      survivorID: "s1",
    })
    // The corpse sits on the cell the survivor's own neck now occupies.
    expect(next.playerPieces.s1).toContain(next.deaths.s2.cell)
  })

  // 3. Both leave nothing behind, so this is the one genuine snake-vs-snake
  // EDGE contest — the case the legacy engine had no rule for.
  it("(3a) two length-1 snakes, equal tier: an edge deadlock, one record per cell", () => {
    const next = faceOff([at(5, 5)], [at(6, 5)], at(5, 5))

    expect(next.alivePlayers.sort()).toEqual(["sb1", "sb2"])
    expect(next.deaths).toEqual({
      s1: { cell: at(5, 5), subStep: 1, cause: "edge" },
      s2: { cell: at(6, 5), subStep: 1, cause: "edge" },
    })
    const edges = next.clashes.filter((c) => c.kind === "edge")
    expect(edges.map((c) => c.index)).toEqual([at(5, 5), at(6, 5)])
    edges.forEach((c) => {
      expect(c.playerIDs).toEqual(["s1", "s2"])
      expect(c.reason).toBe(REASON.tie)
      expect(c.survivorID).toBeUndefined()
    })
    expect(edges[0].victimIDs).toEqual(["s1"])
    expect(edges[1].victimIDs).toEqual(["s2"])
  })

  it("(3b) two length-1 snakes, unequal tier: the winner takes the loser's cell and the corpse lands under it", () => {
    const next = faceOff([at(5, 5)], [at(6, 5)], at(5, 5), {
      playerInvulnerabilityLevel: { s1: 1, s2: 0, sb1: 0, sb2: 0 },
    })

    expect(next.alivePlayers.sort()).toEqual(["s1", "sb1", "sb2"])
    expect(next.playerPieces.s1).toEqual([at(6, 5)])
    expect(next.deaths).toEqual({
      s2: { cell: at(6, 5), subStep: 1, cause: "edge" },
    })
    // Winner and loser both report (6,5): the loser never crossed, and the
    // winner completed into the cell the loser was standing on.
    expect(next.moves.s1).toBe(at(6, 5))
    expect(next.moves.s2).toBe(at(6, 5))
    expect(next.clashes.find((c) => c.kind === "edge")).toMatchObject({
      index: at(6, 5),
      victimIDs: ["s2"],
      survivorID: "s1",
      reason: REASON.tier,
    })
  })

  // 4. Sever and bodyBlock fire in the same sub-step, each adjudicated against
  // the same snapshot: the higher tier cuts the neck it landed on, and the
  // lower tier dies on the neck IT landed on. Because the owner is removed
  // outright, its recorded cut never truncates anything.
  it("(4) higher tier vs lower tier, both length 2: simultaneous sever and bodyBlock", () => {
    const next = faceOff([at(5, 5), at(4, 5)], [at(6, 5), at(7, 5)], at(5, 5), {
      playerInvulnerabilityLevel: { s1: 1, s2: 0, sb1: 0, sb2: 0 },
    })

    expect(next.alivePlayers.sort()).toEqual(["s1", "sb1", "sb2"])
    expect(next.playerPieces.s1).toEqual([at(6, 5), at(5, 5)])
    expect(next.deaths).toEqual({
      s2: { cell: at(5, 5), subStep: 1, cause: "bodyBlock" },
    })
    expect(next.clashes.find((c) => c.kind === "sever")).toMatchObject({
      index: at(6, 5),
      playerIDs: ["s1", "s2"],
      victimIDs: [],
      survivorID: "s1",
    })
    // The severed owner died the same sub-step, so the cut is recorded on the
    // wire but truncates nothing: severedCells only ever names SURVIVORS.
    expect(next.severedCells).toBeUndefined()
  })

  it("(4) the same outcome under any roster order", () => {
    agreesUnderPermutation({
      players: [
        gp("s1", "t1", "A", "snake"),
        gp("s2", "t2", "A", "snake"),
        ...bystanderPlayers,
      ],
      pieces: {
        s1: [at(5, 5), at(4, 5)],
        s2: [at(6, 5), at(7, 5)],
        ...bystanders,
      },
      moves: [mv("s1", at(6, 5)), mv("s2", at(5, 5)), ...bystanderMoves],
      turn: { playerInvulnerabilityLevel: { s1: 1, s2: 0, sb1: 0, sb2: 0 } },
    })
  })

  // 5. You cannot chase a head: by the time the chaser arrives, the cell the
  // head left is the fleeing snake's neck.
  it("(5a) chasing a fleeing head at equal tier walks into its neck and dies", () => {
    const next = faceOff([at(5, 5), at(4, 5)], [at(6, 5), at(6, 6)], at(7, 5))

    expect(next.alivePlayers.sort()).toEqual(["s2", "sb1", "sb2"])
    expect(next.playerPieces.s2).toEqual([at(7, 5), at(6, 5)])
    expect(next.deaths).toEqual({
      s1: { cell: at(6, 5), subStep: 1, cause: "bodyBlock" },
    })
    expect(next.clashes.find((c) => c.kind === "bodyBlock")).toMatchObject({
      index: at(6, 5),
      victimIDs: ["s1"],
      survivorID: "s2",
    })
  })

  it("(5b) a higher-tier chaser cuts the neck instead, and both live", () => {
    const next = faceOff([at(5, 5), at(4, 5)], [at(6, 5), at(6, 6)], at(7, 5), {
      playerInvulnerabilityLevel: { s1: 1, s2: 0, sb1: 0, sb2: 0 },
    })

    expect(next.alivePlayers.sort()).toEqual(["s1", "s2", "sb1", "sb2"])
    expect(next.deaths).toEqual({})
    expect(next.playerPieces.s1).toEqual([at(6, 5), at(5, 5)])
    // The fleeing snake is cut down to its head — and a length-1 snake is
    // exactly the one that contests edges next turn.
    expect(next.playerPieces.s2).toEqual([at(7, 5)])
    expect(next.severedCells).toEqual({ s2: [at(6, 5)] })
  })

  // 6. Collisions adjudicate strictly before health, so a hazard on the
  // destination never pre-empts the collision that was already decided.
  it("(6a) a hazard on the destination does not change who killed whom", () => {
    const next = faceOff(
      [at(5, 5), at(4, 5)],
      [at(6, 5), at(7, 5)],
      at(5, 5),
      {
        hazards: [at(6, 5)],
        playerHealth: { s1: 10, s2: 100, sb1: 100, sb2: 100 },
      },
      { hazardDamage: 30 }
    )

    // s1 would have starved on the hazard, but it died to the neck first: the
    // cause on the wire is the collision, and it is charged no hazard dose.
    expect(next.deaths.s1).toEqual({
      cell: at(6, 5),
      subStep: 1,
      cause: "bodyBlock",
    })
    expect(next.clashes.some((c) => c.kind === "hazard")).toBe(false)
  })

  it("(6b) a survivor of the collision can still starve on that same cell, that same sub-step", () => {
    const next = faceOff(
      [at(5, 5), at(4, 5)],
      [at(6, 5), at(7, 5)],
      at(5, 5),
      {
        hazards: [at(6, 5)],
        playerHealth: { s1: 10, s2: 100, sb1: 100, sb2: 100 },
        playerInvulnerabilityLevel: { s1: 1, s2: 0, sb1: 0, sb2: 0 },
      },
      { hazardDamage: 30 }
    )

    expect(next.alivePlayers.sort()).toEqual(["sb1", "sb2"])
    expect(next.deaths).toEqual({
      s1: { cell: at(6, 5), subStep: 1, cause: "hazard" },
      s2: { cell: at(5, 5), subStep: 1, cause: "bodyBlock" },
    })
    // The sever it landed still went on the wire — it just outlived nobody.
    const sever = next.clashes.find((c) => c.kind === "sever")
    expect(sever).toMatchObject({ index: at(6, 5), victimIDs: [] })
    expect(sever!.survivorID).toBeUndefined()
    expect(next.severedCells).toBeUndefined()
  })
})
