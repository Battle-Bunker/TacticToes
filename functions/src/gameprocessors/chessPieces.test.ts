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

// 11x11 board: index = y * 11 + x, perimeter is wall (interior 1..9).
const W = 11
const at = (x: number, y: number): number => y * W + x

const twoTeams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#00ff00" },
]

const mkSetup = (
  teams: Team[],
  gamePlayers: GamePlayer[],
  overrides: Partial<StartedGameSetup> = {}
): StartedGameSetup => ({
  teams,
  snakesPerTeam: 1,
  gamePlayers,
  boardWidth: W,
  boardHeight: W,
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
    ...overrides,
  }
}

const mkGameState = (setup: StartedGameSetup, turn: Turn): GameState => ({
  setup,
  turns: [turn],
  walls: [],
  timeCreated: Timestamp.fromMillis(0),
  timeFinished: null,
})

const mv = (playerID: string, move: number): Move => ({
  gameID: "game1",
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(0),
})

const gp = (
  id: string,
  teamID: string,
  letter: string,
  unitType: GamePlayer["unitType"]
): GamePlayer => ({ id, teamID, letter, unitType })

const run = (
  gamePlayers: GamePlayer[],
  pieces: { [playerID: string]: number[] },
  moves: Move[],
  turnOverrides: Partial<Turn> = {},
  setupOverrides: Partial<StartedGameSetup> = {},
  teams: Team[] = twoTeams
): Turn => {
  const turn = mkTurn(pieces, {
    unitTypes: Object.fromEntries(
      gamePlayers.map((p) => [p.id, p.unitType ?? "snake"])
    ),
    ...turnOverrides,
  })
  const processor = new TeamSnekProcessor(
    mkGameState(mkSetup(teams, gamePlayers, setupOverrides), turn)
  )
  return processor.applyMoves(turn, moves)
}

describe("chess pieces: within-turn movement and collisions", () => {
  it("two equal-weight bishops crossing paths die at the crossing square, in flight", () => {
    const players = [gp("t1", "t1", "A", "bishop"), gp("t2", "t2", "A", "bishop")]
    // b1 (2,2) -> (6,6); b2 (6,2) -> (2,6). Both pass (4,4) at sub-step 2.
    const next = run(
      players,
      { t1: [at(2, 2)], t2: [at(6, 2)] },
      [mv("t1", at(6, 6)), mv("t2", at(2, 6))]
    )

    expect(next.alivePlayers).toEqual([])
    expect(next.playerPieces).toEqual({})
    const clash = next.clashes.find((c) => c.index === at(4, 4))
    expect(clash).toBeDefined()
    expect(clash!.subStep).toBe(2)
    expect(clash!.playerIDs.sort()).toEqual(["t1", "t2"])
  })

  it("a heavier rook kills a lighter stationary piece mid-path and stops on the kill square", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "bishop")]
    const rookStart = at(1, 5)
    const blocker = at(4, 5)
    const next = run(
      players,
      { t1: [rookStart, rookStart, rookStart], t2: [blocker] }, // weight 3 vs 1
      [mv("t1", at(9, 5))] // t2 stays
    )

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([blocker, blocker, blocker])
    expect(next.moves.t1).toBe(blocker) // applied move = actual stop square
    expect(next.paths?.t1).toEqual([at(2, 5), at(3, 5), blocker])
    // 3 squares traversed, no base tick
    expect(next.playerHealth.t1).toBe(97)
    expect(
      next.clashes.some((c) => c.index === blocker && c.reason.includes("lighter unit"))
    ).toBe(true)
  })

  it("equal-weight mover vs stationary piece: tie kills both", () => {
    const players = [gp("t1", "t1", "A", "king"), gp("t2", "t2", "A", "knight")]
    const target = at(5, 5)
    const next = run(
      players,
      { t1: [at(4, 5)], t2: [target] },
      [mv("t1", target)]
    )

    expect(next.alivePlayers).toEqual([])
  })

  it("a slider hitting a snake's body dies — snake bodies stay walls", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "snake")]
    // Snake body crosses the rook's row at (5,5); its head is elsewhere.
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(5, 3), at(5, 4), at(5, 5), at(5, 6)] },
      [mv("t1", at(9, 5)), mv("t2", at(5, 2))]
    )

    expect(next.alivePlayers).toEqual(["t2"])
    expect(
      next.clashes.some((c) => c.reason === "Collided with another snake's body" && c.playerIDs.includes("t1"))
    ).toBe(true)
  })

  it("a higher-tier slider severs a snake body at the contact segment and stops there", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "snake")]
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(5, 3), at(5, 4), at(5, 5), at(5, 6)] },
      [mv("t1", at(9, 5)), mv("t2", at(5, 2))],
      { playerInvulnerabilityLevel: { t1: 1, t2: 0 } }
    )

    // Snake post-move body is [(5,2),(5,3),(5,4),(5,5)] (tail (5,6) popped);
    // the rook meets the (5,5) segment at sub-step 4, severs it, and stops.
    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerPieces.t1).toEqual([at(5, 5)])
    expect(next.playerPieces.t2).toEqual([at(5, 2), at(5, 3), at(5, 4)])
    expect(
      next.clashes.some((c) => c.reason === "Body severed by invulnerable snake")
    ).toBe(true)
    expect(next.playerHealth.t1).toBe(96) // 4 squares traversed
  })

  it("a snake head entering a stationary piece's square resolves by weight", () => {
    // Snake length 3 vs piece weight 1: piece dies, snake survives.
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "pawn")]
    const target = at(5, 5)
    const next = run(
      players,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: [target] },
      [mv("t1", target)]
    )
    expect(next.alivePlayers).toEqual(["t1"])

    // Piece weight 5 vs snake length 3: snake dies.
    const players2 = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "rook")]
    const heavy = [target, target, target, target, target]
    const next2 = run(
      players2,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: heavy },
      [mv("t1", target)]
    )
    expect(next2.alivePlayers).toEqual(["t2"])
  })

  it("two pieces exchanging squares collide in flight (heavier wins and completes the step)", () => {
    const players = [gp("t1", "t1", "A", "king"), gp("t2", "t2", "A", "king")]
    const a = at(4, 5)
    const b = at(5, 5)
    const next = run(
      players,
      { t1: [a, a], t2: [b] }, // weight 2 vs 1
      [mv("t1", b), mv("t2", a)]
    )

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([b, b])
  })

  it("knights jump over intervening units and pay a flat 1 movement cost", () => {
    const players = [gp("t1", "t1", "A", "knight"), gp("t2", "t2", "A", "snake")]
    // Knight (4,4) -> (5,6); snake body wall on the intervening row.
    const next = run(
      players,
      { t1: [at(4, 4)], t2: [at(3, 5), at(4, 5), at(5, 5), at(6, 5)] },
      [mv("t1", at(5, 6)), mv("t2", at(3, 4))]
    )

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerPieces.t1).toEqual([at(5, 6)])
    expect(next.playerHealth.t1).toBe(99) // the jump costs a flat 1
  })

  it("food is eaten at the destination only — squares passed over keep their food", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const passedFood = at(4, 5)
    const destFood = at(7, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(9, 9)] },
      [mv("t1", destFood)],
      { food: [passedFood, destFood] }
    )

    expect(next.food).toEqual([passedFood])
    expect(next.playerPieces.t1).toEqual([destFood, destFood]) // grew to weight 2
    expect(next.playerHealth.t1).toBe(100)
  })

  it("a slider entering a hazard square mid-path dies there", () => {
    const players = [gp("t1", "t1", "A", "queen"), gp("t2", "t2", "A", "king")]
    const hazard = at(4, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(9, 9)] },
      [mv("t1", at(8, 5))],
      { hazards: [hazard] }
    )

    expect(next.alivePlayers).toEqual(["t2"])
    const clash = next.clashes.find((c) => c.playerIDs.includes("t1"))
    expect(clash!.reason).toBe("Entered hazard")
    expect(clash!.index).toBe(hazard)
    expect(clash!.subStep).toBe(3)
  })

  it("a piece with nothing staged (or an illegal destination) stays and spends no health", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "bishop")]
    const rookAt = at(3, 3)
    const bishopAt = at(7, 7)
    const next = run(
      players,
      { t1: [rookAt], t2: [bishopAt] },
      [mv("t2", at(6, 7))] // not on a diagonal — illegal for a bishop
    )

    expect(next.playerPieces.t1).toEqual([rookAt])
    expect(next.playerPieces.t2).toEqual([bishopAt])
    expect(next.moves.t1).toBe(rookAt)
    expect(next.moves.t2).toBe(bishopAt)
    expect(next.playerHealth.t1).toBe(100)
    expect(next.playerHealth.t2).toBe(100)
  })
})

describe("chess pieces: pawns", () => {
  it("staging a side square spends the turn rotating 90°", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt], t2: [at(8, 8)] },
      [mv("t1", at(3, 4))], // side square relative to facing {dx:1,dy:0}
      { unitFacing: { t1: { dx: 1, dy: 0 } } }
    )

    expect(next.playerPieces.t1).toEqual([pawnAt]) // did not move
    expect(next.moves.t1).toBe(pawnAt)
    expect(next.unitFacing?.t1).toEqual({ dx: 0, dy: -1 })
    expect(next.playerHealth.t1).toBe(100) // no movement cost
  })

  it("moves straight forward; diagonal only onto food or a unit; never backward", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const facing = { unitFacing: { t1: { dx: 1, dy: 0 } } }

    // Straight forward is legal.
    const fwd = run(players, { t1: [pawnAt], t2: [at(8, 8)] }, [mv("t1", at(4, 5))], facing)
    expect(fwd.playerPieces.t1).toEqual([at(4, 5)])

    // Diagonal-forward onto an empty square is illegal — pawn stays.
    const diagEmpty = run(players, { t1: [pawnAt], t2: [at(8, 8)] }, [mv("t1", at(4, 4))], facing)
    expect(diagEmpty.playerPieces.t1).toEqual([pawnAt])

    // Diagonal-forward onto food is legal and eats.
    const diagFood = run(
      players,
      { t1: [pawnAt], t2: [at(8, 8)] },
      [mv("t1", at(4, 4))],
      { ...facing, food: [at(4, 4)] }
    )
    expect(diagFood.playerPieces.t1).toEqual([at(4, 4), at(4, 4)])
    expect(diagFood.playerHealth.t1).toBe(100)

    // Backward is illegal — pawn stays.
    const back = run(players, { t1: [pawnAt], t2: [at(8, 8)] }, [mv("t1", at(2, 5))], facing)
    expect(back.playerPieces.t1).toEqual([pawnAt])
  })

  it("a pawn attacking diagonally fights the occupant by weight", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "pawn")]
    const attacker = [at(3, 5), at(3, 5)] // weight 2
    const victim = [at(4, 4)] // weight 1
    const next = run(
      players,
      { t1: attacker, t2: victim },
      [mv("t1", at(4, 4))],
      { unitFacing: { t1: { dx: 1, dy: 0 }, t2: { dx: -1, dy: 0 } } }
    )

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([at(4, 4), at(4, 4)])
  })

  it("promotes to queen at the configured weight and can then slide", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] }, // weight 2, threshold 3
      [mv("t1", at(4, 5))],
      { unitFacing: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3 }
    )

    expect(next.playerPieces.t1).toHaveLength(3)
    expect(next.unitTypes?.t1).toBe("queen")

    // Next turn the promoted queen slides like a queen.
    const players2 = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const turn2 = run(
      players2,
      { t1: [at(4, 5), at(4, 5), at(4, 5)], t2: [at(8, 8)] },
      [mv("t1", at(4, 8))],
      { unitTypes: { t1: "queen", t2: "king" } }
    )
    expect(turn2.playerPieces.t1).toEqual([at(4, 8), at(4, 8), at(4, 8)])
  })
})

describe("chess pieces: regicide and winners", () => {
  it("a team configured with a king loses all units when its last king dies", () => {
    const players = [
      gp("t1", "t1", "A", "king"),
      gp("t1#2", "t1", "B", "rook"),
      gp("t2", "t2", "A", "queen"),
    ]
    // t2's queen (weight 3) captures t1's king (weight 1).
    const kingAt = at(5, 5)
    const next = run(
      players,
      { t1: [kingAt], "t1#2": [at(2, 8)], t2: [at(5, 2), at(5, 2), at(5, 2)] },
      [mv("t2", kingAt)]
    )

    expect(next.alivePlayers).toEqual(["t2"])
    expect(
      next.clashes.some((c) => c.reason === "Team eliminated: king fell" && c.playerIDs.includes("t1#2"))
    ).toBe(true)
    // t2 is the last team standing — it wins.
    expect(next.winners.length).toBeGreaterThan(0)
    expect(next.winners[0].teamID).toBe("t2")
  })

  it("pure chess: last team standing wins with team score = summed weights", () => {
    const players = [
      gp("t1", "t1", "A", "rook"),
      gp("t2", "t2", "A", "bishop"),
      gp("t2#2", "t2", "B", "knight"),
    ]
    // t1's weight-1 rook slides into t2's weight-2 bishop and loses.
    const bishopAt = at(6, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [bishopAt, bishopAt], "t2#2": [at(8, 8)] },
      [mv("t1", at(9, 5))]
    )

    expect(next.alivePlayers.sort()).toEqual(["t2", "t2#2"])
    expect(next.winners.length).toBe(2)
    expect(next.winners[0].teamID).toBe("t2")
    expect(next.winners[0].teamScore).toBe(3) // bishop 2 + knight 1
  })

  it("snakes keep their semantics inside a chess game (tail-chase into a vacated cell survives)", () => {
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "king")]
    // Snake in a 2x2 loop chasing its own tail.
    const next = run(
      players,
      { t1: [at(4, 4), at(5, 4), at(5, 5), at(4, 5)], t2: [at(8, 8)] },
      [mv("t1", at(4, 5))] // into the cell its tail vacates this turn
    )

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerPieces.t1).toEqual([at(4, 5), at(4, 4), at(5, 4), at(5, 5)])
  })
})

describe("configurable hazard damage", () => {
  it("a slider crossing a hazard square with low hazardDamage survives and keeps sliding", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(9, 9)] },
      [mv("t1", at(8, 5))],
      { hazards: [at(4, 5)] },
      { hazardDamage: 30 }
    )

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerPieces.t1).toEqual([at(8, 5)]) // completed the slide
    // one 30 dose on the hazard square + 7 squares traversed
    expect(next.playerHealth.t1).toBe(63)
    expect(next.clashes).toEqual([])
  })

  it("a low-health slider dies mid-flight on the hazard square that drained it", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(9, 9)] },
      [mv("t1", at(9, 5))],
      { hazards: [at(3, 5), at(5, 5)], playerHealth: { t1: 50, t2: 100 } },
      { hazardDamage: 30 }
    )

    expect(next.alivePlayers).toEqual(["t2"])
    const clash = next.clashes.find((c) => c.playerIDs.includes("t1"))
    expect(clash!.reason).toBe("Entered hazard")
    expect(clash!.index).toBe(at(5, 5)) // second hazard square: 50 - 30 - 30 ≤ 0
    expect(clash!.subStep).toBe(4)
  })

  it("a stationary piece sitting on a hazard square soaks one dose per turn", () => {
    const players = [gp("t1", "t1", "A", "bishop"), gp("t2", "t2", "A", "king")]
    const hazard = at(4, 5)
    const next = run(
      players,
      { t1: [hazard], t2: [at(8, 8)] },
      [], // both stay put
      { hazards: [hazard] },
      { hazardDamage: 30 }
    )

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerHealth.t1).toBe(70) // exactly one dose, no movement cost
    expect(next.playerHealth.t2).toBe(100)
  })

  it("a mover that stops on a hazard square pays the entry dose exactly once", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const hazard = at(4, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(8, 8)] },
      [mv("t1", hazard)],
      { hazards: [hazard] },
      { hazardDamage: 30 }
    )

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerPieces.t1).toEqual([hazard])
    // one 30 dose on entry + 3 squares traversed — no extra stationary dose
    expect(next.playerHealth.t1).toBe(67)
  })

  it("a king holding still loses no health across a turn, even at 1 health", () => {
    const players = [gp("t1", "t1", "A", "king"), gp("t2", "t2", "A", "rook")]
    const next = run(
      players,
      { t1: [at(5, 5)], t2: [at(8, 8)] },
      [mv("t2", at(8, 6))],
      { playerHealth: { t1: 1, t2: 100 } }
    )

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerHealth.t1).toBe(1) // holding is free
    expect(next.playerHealth.t2).toBe(98) // rook paid its 2 squares
  })

  it("a snake in a chess game still loses exactly 1 health per turn", () => {
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: [at(8, 8)] },
      [mv("t1", at(5, 5))]
    )

    expect(next.playerHealth.t1).toBe(99)
    expect(next.playerHealth.t2).toBe(100)
  })
})

describe("configurable per-unit-type max health", () => {
  it("initial health honors the per-type config, defaulting missing types to 100", () => {
    const players = [
      gp("t1", "t1", "A", "snake"),
      gp("t1#2", "t1", "B", "knight"),
      gp("t2", "t2", "A", "rook"),
    ]
    const setup = mkSetup(twoTeams, players, {
      maxHealthPerUnit: { snake: 150, rook: 60 },
    })
    const processor = new TeamSnekProcessor({
      setup,
      turns: [],
      walls: [],
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: null,
    })
    const turn0 = processor.firstTurn()

    expect(turn0.playerHealth.t1).toBe(150) // configured snake max
    expect(turn0.playerHealth["t1#2"]).toBe(100) // knight not configured
    expect(turn0.playerHealth.t2).toBe(60) // configured rook max
  })

  it("snake path: eating restores to the configured snake max", () => {
    // Snake-only game — resolves through the original single-pass path.
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "snake")]
    const foodAt = at(5, 5)
    const next = run(
      players,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: [at(8, 8), at(8, 7), at(8, 6)] },
      [mv("t1", foodAt), mv("t2", at(8, 9))],
      { food: [foodAt], playerHealth: { t1: 10, t2: 100 } },
      { maxHealthPerUnit: { snake: 40 } }
    )

    expect(next.playerHealth.t1).toBe(40) // restored to configured max, not 100
    expect(next.playerHealth.t2).toBe(99) // normal 1/turn drain untouched
  })

  it("chess path: eating restores to the unit's current type's configured max", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const foodAt = at(3, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(8, 8)] },
      [mv("t1", foodAt)],
      { food: [foodAt], playerHealth: { t1: 20, t2: 100 } },
      { maxHealthPerUnit: { rook: 55 } }
    )

    expect(next.playerHealth.t1).toBe(55) // rook max, despite traversal costs
    expect(next.playerHealth.t2).toBe(100) // king stayed put: spends nothing
  })

  it("pawn promotion clamps carried health to the queen's configured max", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] }, // weight 2, threshold 3
      [mv("t1", at(4, 5))],
      { unitFacing: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3, maxHealthPerUnit: { pawn: 200, queen: 50 } }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    // Ate as a pawn (restored to 200), then clamped to the queen max on promotion.
    expect(next.playerHealth.t1).toBe(50)
  })

  it("pawn promotion leaves health alone when it is within the queen's max", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] },
      [mv("t1", at(4, 5))],
      { unitFacing: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3, maxHealthPerUnit: { pawn: 80, queen: 500 } }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    expect(next.playerHealth.t1).toBe(80) // pawn restore carried through unclamped
  })

  it("config absent: everything restores to 100 exactly as before", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const foodAt = at(3, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(8, 8)] },
      [mv("t1", foodAt)],
      { food: [foodAt], playerHealth: { t1: 20, t2: 100 } }
    )

    expect(next.playerHealth.t1).toBe(100)
    expect(next.playerHealth.t2).toBe(100) // stationary king spends nothing
  })
})
