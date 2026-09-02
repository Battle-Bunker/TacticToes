import { Timestamp } from "firebase-admin/firestore"
import {
  GamePlayer,
  GameState,
  Move,
  StartedGameSetup,
  Team,
  Turn,
  UnitType,
} from "@shared/types/Game"
import { TeamSnekProcessor } from "./TeamSnekProcessor"
import { spawnOrientationCandidates } from "./engine/moveGrammar"
import { REASON } from "./engine/turnEngine"

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
    ...overrides,
    // Every unit carries an orientation; tests override the units whose orientation
    // matters.
    orientation: {
      ...Object.fromEntries(ids.map((id) => [id, { dx: 1, dy: 0 }])),
      ...overrides.orientation,
    },
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
    // Death-square guarantee: each dead piece's move is the square it died
    // on, and its path ends there.
    expect(next.moves.t1).toBe(at(4, 4))
    expect(next.moves.t2).toBe(at(4, 4))
    expect(next.paths?.t1).toEqual([at(3, 3), at(4, 4)])
    expect(next.paths?.t2).toEqual([at(5, 3), at(4, 4)])
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
    expect(next.playerEnergy.t1).toBe(97)
    const clash = next.clashes.find((c) => c.index === blocker)
    expect(clash).toMatchObject({
      kind: "contest",
      reason: REASON.weight,
      victimIDs: ["t2"],
      survivorID: "t1",
    })
    expect(clash!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(next.deaths.t2).toEqual({ cell: blocker, subStep: 3, cause: "contest" })
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
      next.clashes.some((c) => c.reason === REASON.bodyBlock && c.playerIDs.includes("t1"))
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
      next.clashes.some((c) => c.reason === REASON.sever)
    ).toBe(true)
    expect(next.playerEnergy.t1).toBe(96) // 4 squares traversed
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
    expect(next.playerEnergy.t1).toBe(99) // the jump costs a flat 1
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
    expect(next.playerEnergy.t1).toBe(100)
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
    expect(clash!.reason).toBe(REASON.hazard)
    expect(clash!.index).toBe(hazard)
    expect(clash!.subStep).toBe(3)
    // Death-square guarantee: the move and path end on the hazard square.
    expect(next.moves.t1).toBe(hazard)
    expect(next.paths?.t1).toEqual([at(2, 5), at(3, 5), hazard])
  })

  it("a piece with nothing staged (or an illegal destination) stays and spends no energy", () => {
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
    expect(next.playerEnergy.t1).toBe(100)
    expect(next.playerEnergy.t2).toBe(100)
  })
})

describe("chess pieces: in-flight edge swaps", () => {
  // Two pieces trading squares through one edge never pass through each other.
  // The edge is contested BEFORE either piece is credited with entering its
  // destination: the winner completes onto its target (the loser's start
  // square) and stops; the loser dies on the square it started the sub-step
  // on, and that square is what its body, clash, path and move all record.
  //
  // Head-on rook setup used below: t1 slides right from (2,5), t2 slides left
  // from (5,5). Sub-step 1 puts them on (3,5) and (4,5); sub-step 2 is the
  // swap through the (3,5)|(4,5) edge.
  const swapRooks = (
    t1Body: number[],
    t2Body: number[],
    turnOverrides: Partial<Turn> = {},
    setupOverrides: Partial<StartedGameSetup> = {}
  ): Turn =>
    run(
      [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "rook")],
      { t1: t1Body, t2: t2Body },
      [mv("t1", at(9, 5)), mv("t2", at(1, 5))],
      turnOverrides,
      setupOverrides
    )

  it("unequal weight: the heavier piece completes the step, the loser dies on its own square", () => {
    const a = at(3, 5) // t1's square at the start of sub-step 2
    const b = at(4, 5) // t2's square at the start of sub-step 2
    const start = at(2, 5)
    const next = swapRooks([start, start], [at(5, 5)]) // weight 2 vs 1

    expect(next.alivePlayers).toEqual(["t1"])
    // Winner: onto the loser's square, and stopped there (its ray is cut short).
    expect(next.playerPieces.t1).toEqual([b, b])
    expect(next.moves.t1).toBe(b)
    expect(next.paths?.t1).toEqual([a, b])
    expect(next.playerEnergy.t1).toBe(98) // 2 squares traversed

    // Loser: dead on b, the square it was blocked on — never on a, the square
    // it tried to swap into.
    expect(next.moves.t2).toBe(b)
    expect(next.paths?.t2).toEqual([b]) // the sub-step-2 entry is undone
    expect(next.clashes.some((c) => c.index === a)).toBe(false)
    const clash = next.clashes.find((c) => c.index === b)
    expect(clash!.reason).toBe(REASON.weight)
    expect(clash!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(clash!.subStep).toBe(2)
  })

  it("equal weight and tier: both die, each on its own square, neither passes through", () => {
    const a = at(3, 5)
    const b = at(4, 5)
    const next = swapRooks([at(2, 5)], [at(5, 5)]) // weight 1 vs 1

    expect(next.alivePlayers).toEqual([])
    expect(next.playerPieces).toEqual({})
    // Each records the adjacent square it was standing on, not the swapped one.
    expect(next.moves.t1).toBe(a)
    expect(next.moves.t2).toBe(b)
    expect(next.paths?.t1).toEqual([a])
    expect(next.paths?.t2).toEqual([b])
    const onA = next.clashes.find((c) => c.index === a)
    const onB = next.clashes.find((c) => c.index === b)
    expect(onA!.subStep).toBe(2)
    expect(onB!.subStep).toBe(2)
    expect(onA!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(onB!.playerIDs.sort()).toEqual(["t1", "t2"])
  })

  it("tier beats weight: the lighter invulnerable piece wins and the heavy loser dies where it stood", () => {
    const a = at(3, 5)
    const b = at(4, 5)
    const heavy = at(5, 5)
    const next = swapRooks([at(2, 5)], [heavy, heavy, heavy], {
      playerInvulnerabilityLevel: { t1: 1, t2: 0 },
    })

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([b])
    expect(next.moves.t1).toBe(b)
    expect(next.moves.t2).toBe(b) // its own start square, not a
    expect(next.paths?.t2).toEqual([b])
    expect(next.clashes.some((c) => c.index === a)).toBe(false)
    const clash = next.clashes.find((c) => c.index === b)
    expect(clash!.reason).toBe(REASON.tier)
    expect(clash!.subStep).toBe(2)
  })

  it("a swap loser is not dosed by a hazard on the square it never entered", () => {
    const a = at(3, 5) // t1's square, hazardous — t2 stages into it and dies first
    const b = at(4, 5)
    const start = at(2, 5)
    const next = swapRooks(
      [start, start],
      [at(5, 5)],
      { hazards: [a], playerEnergy: { t1: 100, t2: 10 } },
      { hazardDamage: 30 }
    )

    // The swap is adjudicated before the hazard charge, so t2 dies to the
    // collision on its own square — not to a hazard on a square it never
    // reached.
    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.clashes.some((c) => c.reason === REASON.hazard)).toBe(false)
    expect(next.clashes.some((c) => c.index === a)).toBe(false)
    const clash = next.clashes.find((c) => c.index === b)
    expect(clash!.reason).toBe(REASON.weight)
    expect(clash!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(next.moves.t2).toBe(b)
  })

  it("the swap winner still pays the hazard dose for the square it lands on", () => {
    const b = at(4, 5)
    const start = at(2, 5)
    const next = swapRooks(
      [start, start],
      [at(5, 5)],
      { hazards: [b] },
      { hazardDamage: 30 }
    )

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([b, b])
    expect(next.playerEnergy.t1).toBe(68) // one 30 dose on entry + 2 squares
  })

  it("regression: a head-on meeting on ONE square is unchanged — no revert", () => {
    // t1 (2,5) and t2 (6,5) slide toward each other over an even gap, so they
    // land on the same square instead of trading squares. The loser keeps the
    // meeting square as its death square, exactly as before.
    const meet = at(4, 5)
    const start = at(2, 5)
    const next = run(
      [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "rook")],
      { t1: [start, start], t2: [at(6, 5)] }, // weight 2 vs 1
      [mv("t1", at(9, 5)), mv("t2", at(1, 5))]
    )

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([meet, meet])
    expect(next.moves.t1).toBe(meet)
    expect(next.paths?.t1).toEqual([at(3, 5), meet])
    // The loser died where it arrived — its path still ends on the shared square.
    expect(next.moves.t2).toBe(meet)
    expect(next.paths?.t2).toEqual([at(5, 5), meet])
    const clash = next.clashes.find((c) => c.index === meet)
    expect(clash!.reason).toBe(REASON.weight)
    expect(clash!.subStep).toBe(2)
  })

  // The edge contest is UNIFORM: two units whose heads exchange through one
  // edge contest it, trail or no trail. The only exemption is a jump, which
  // traverses no edge — and a knight's L never lands adjacent anyway, so no
  // unit can actually exchange heads with one. A losing trail unit is squashed
  // against its own neck: only its head is reverted, the tail pop stands.
  const snakeSwap = (
    snakeBody: number[],
    pieceBody: number[],
    turnOverrides: Partial<Turn> = {}
  ): Turn =>
    run(
      [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "rook")],
      { t1: snakeBody, t2: pieceBody },
      [mv("t1", at(6, 5)), mv("t2", at(5, 5))],
      turnOverrides
    )

  it("a length-1 snake swapping with a heavier piece dies on its own square", () => {
    const snakeAt = at(5, 5)
    const rookAt = at(6, 5)
    const next = snakeSwap([snakeAt], [rookAt, rookAt]) // weight 1 vs 2

    expect(next.alivePlayers).toEqual(["t2"])
    expect(next.playerPieces.t2).toEqual([snakeAt, snakeAt]) // winner completes
    expect(next.moves.t2).toBe(snakeAt)
    // The snake never reached its attempted head square, so it records the
    // square it was blocked on instead.
    expect(next.moves.t1).toBe(snakeAt)
    expect(next.clashes.some((c) => c.index === rookAt)).toBe(false)
    const clash = next.clashes.find((c) => c.index === snakeAt)
    expect(clash!.reason).toBe(REASON.weight)
    expect(clash!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(clash!.subStep).toBe(1)
  })

  it("a length-1 snake swapping with an equal-weight piece: tie kills both where they stood", () => {
    const snakeAt = at(5, 5)
    const rookAt = at(6, 5)
    const next = snakeSwap([snakeAt], [rookAt]) // weight 1 vs 1

    expect(next.alivePlayers).toEqual([])
    expect(next.moves.t1).toBe(snakeAt)
    expect(next.moves.t2).toBe(rookAt)
    expect(next.paths?.t2).toBeUndefined() // the rook never entered a square
    const onSnake = next.clashes.find((c) => c.index === snakeAt)
    const onRook = next.clashes.find((c) => c.index === rookAt)
    expect(onSnake!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(onRook!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(onSnake!.subStep).toBe(1)
    expect(onRook!.subStep).toBe(1)
  })

  it("a length-1 snake wins the edge on tier, however heavy the piece is", () => {
    const snakeAt = at(5, 5)
    const rookAt = at(6, 5)
    const next = snakeSwap([snakeAt], [rookAt, rookAt, rookAt], {
      playerInvulnerabilityLevel: { t1: 1, t2: 0 },
    }) // weight 1 vs 3, but tier 1 vs 0

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([rookAt]) // the snake completed its move
    expect(next.moves.t2).toBe(rookAt) // the loser dies where it stood
    expect(next.clashes.some((c) => c.index === snakeAt)).toBe(false)
    const clash = next.clashes.find((c) => c.index === rookAt)
    expect(clash!.reason).toBe(REASON.tier)
  })

  it("two length-1 snakes swapping: tie kills both, each on its own square", () => {
    const a = at(5, 5)
    const b = at(6, 5)
    // A bystander bishop per team, parked and holding: it makes this a piece
    // game (so the sub-step simulation runs at all) and keeps both teams alive,
    // out of the way of the swap.
    const next = run(
      [
        gp("t1", "t1", "A", "snake"),
        gp("t2", "t2", "A", "snake"),
        gp("t1b", "t1", "B", "bishop"),
        gp("t2b", "t2", "B", "bishop"),
      ],
      { t1: [a], t2: [b], t1b: [at(1, 1)], t2b: [at(9, 9)] },
      [mv("t1", b), mv("t2", a)]
    )

    expect(next.alivePlayers.sort()).toEqual(["t1b", "t2b"])
    expect(next.moves.t1).toBe(a)
    expect(next.moves.t2).toBe(b)
    expect(next.clashes.find((c) => c.index === a)!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(next.clashes.find((c) => c.index === b)!.playerIDs.sort()).toEqual(["t1", "t2"])
  })

  // INVERTED. This used to assert the trail exemption: the rook was said to
  // meet the snake's swept-in neck and die on it, whatever the two weighed.
  // The exchange is now a plain edge contest on frozen weight.
  it("a length-2 snake exchanging heads with a heavier piece loses the edge", () => {
    const head = at(5, 5)
    const rookAt = at(6, 5)
    const next = snakeSwap([head, at(4, 5)], [rookAt, rookAt, rookAt]) // 2 vs 3

    expect(next.alivePlayers).toEqual(["t2"])
    // The winner completes into the loser's head cell and stops there.
    expect(next.playerPieces.t2).toEqual([head, head, head])
    expect(next.moves.t2).toBe(head)
    expect(next.paths?.t2).toEqual([head])
    // The snake is squashed against its own neck: it dies on the cell its head
    // started the sub-step on, never on the one it tried to swap into.
    expect(next.moves.t1).toBe(head)
    expect(next.deaths.t1).toEqual({ cell: head, subStep: 1, cause: "edge" })
    expect(next.clashes.some((c) => c.index === rookAt)).toBe(false)
    expect(next.clashes.find((c) => c.index === head)).toMatchObject({
      kind: "edge",
      reason: REASON.weight,
      victimIDs: ["t1"],
      survivorID: "t2",
    })
  })

  it("and wins the same edge when the snake is the heavier one", () => {
    const head = at(5, 5)
    const rookAt = at(6, 5)
    // Weight 4 vs 1: the snake completes its step and the rook is squashed
    // where it stood, having entered nothing at all.
    const next = snakeSwap([head, at(4, 5), at(3, 5), at(2, 5)], [rookAt])

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([rookAt, head, at(4, 5), at(3, 5)])
    expect(next.moves.t2).toBe(rookAt)
    expect(next.paths?.t2).toBeUndefined()
    expect(next.deaths.t2).toEqual({ cell: rookAt, subStep: 1, cause: "edge" })
  })

  it("a later arrival contests the edge winner and the pile it made, together", () => {
    // The rook wins the edge on (5,5) and stops there. Four sub-steps later a
    // weight-5 rook reaches the same cell and is judged against BOTH the
    // winner standing on it and the snake it squashed there.
    const next = run(
      [
        gp("s", "t1", "A", "snake"),
        gp("r", "t2", "A", "rook"),
        gp("q", "t2", "B", "rook"),
      ],
      {
        s: [at(5, 5), at(4, 5)],
        r: [at(6, 5), at(6, 5), at(6, 5)],
        q: [at(9, 5), at(9, 5), at(9, 5), at(9, 5), at(9, 5)],
      },
      [mv("s", at(6, 5)), mv("r", at(5, 5)), mv("q", at(1, 5))]
    )

    expect(next.alivePlayers).toEqual(["q"])
    expect(next.deaths.s).toEqual({ cell: at(5, 5), subStep: 1, cause: "edge" })
    expect(next.deaths.r).toEqual({ cell: at(5, 5), subStep: 4, cause: "contest" })
    const pile = next.clashes.find((c) => c.kind === "contest")
    expect(pile).toMatchObject({
      index: at(5, 5),
      subStep: 4,
      playerIDs: ["q", "r", "s"],
      victimIDs: ["r"],
      survivorID: "q",
    })
  })
})

describe("chess pieces: death squares on the wire", () => {
  // The client's death rendering relies on this contract: for EVERY unit that
  // dies during a turn, `moves[dead]` is the square it actually died on
  // (pieces: mid-path when stopped in flight; snakes: the attempted head
  // square), a dead piece's `paths` entry ends at that square, and the clash
  // recording the death carries the same square with its subStep.

  it("a slider that dies mid-ray on a snake body records the death square in moves and paths", () => {
    const players = [gp("t1", "t1", "A", "bishop"), gp("t2", "t2", "A", "snake")]
    // Bishop (2,2) -> (6,6); the snake's post-move body covers (4,4), the
    // bishop's second ray square.
    const next = run(
      players,
      { t1: [at(2, 2)], t2: [at(4, 3), at(4, 4), at(4, 5), at(4, 6)] },
      [mv("t1", at(6, 6)), mv("t2", at(4, 2))]
    )

    expect(next.alivePlayers).toEqual(["t2"])
    expect(next.moves.t1).toBe(at(4, 4)) // NOT the staged (6,6), NOT the origin
    expect(next.paths?.t1).toEqual([at(3, 3), at(4, 4)])
    const clash = next.clashes.find((c) => c.playerIDs.includes("t1"))
    expect(clash!.index).toBe(at(4, 4))
    expect(clash!.subStep).toBe(2)
  })

  it("a piece that dies exchanging squares in flight records the square it was blocked on", () => {
    const players = [gp("t1", "t1", "A", "king"), gp("t2", "t2", "A", "king")]
    const a = at(4, 5)
    const b = at(5, 5)
    const next = run(
      players,
      { t1: [a, a], t2: [b] }, // weight 2 vs 1: t2 dies in flight
      [mv("t1", b), mv("t2", a)]
    )

    expect(next.alivePlayers).toEqual(["t1"])
    // t2 never crossed the edge: it dies on b, its own start square (which is
    // also where the winner comes to rest), NOT on a.
    expect(next.moves.t2).toBe(b)
    expect(next.paths?.t2).toBeUndefined()
    expect(next.clashes.some((c) => c.index === a)).toBe(false)
    const clash = next.clashes.find((c) => c.index === b)
    expect(clash!.playerIDs.sort()).toEqual(["t1", "t2"])
    expect(clash!.subStep).toBe(1)
  })

  // INVERTED against the pre-engine behavior. Movement cost used to be
  // settled once, in the food phase, so a piece could complete a ray it could
  // not afford and die on the staged destination. The engine now charges each
  // cell as it is entered, so the piece EXHAUSTS mid-ray and halts where its
  // energy ran out — three cells short of where it was going. Nothing revives
  // it here, so the halt is where it dies.
  it("a piece that exhausts mid-ray halts and dies on the cell that drained it", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const dest = at(5, 5)
    const drained = at(4, 5) // the third cell entered: 3 energy, 1 per cell
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(9, 9)] },
      [mv("t1", dest)],
      { playerEnergy: { t1: 3, t2: 100 } }
    )

    expect(next.alivePlayers).toEqual(["t2"])
    expect(next.moves.t1).toBe(drained)
    expect(next.paths?.t1).toEqual([at(2, 5), at(3, 5), drained])
    expect(next.deaths.t1).toEqual({ cell: drained, subStep: 3, cause: "exhaustion" })
    expect(
      next.clashes.some((c) => c.index === drained && c.reason === REASON.exhaustion)
    ).toBe(true)
  })

  it("a dead snake in a chess game records its attempted head square in moves", () => {
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "rook")]
    const target = at(5, 5)
    const heavy = [target, target, target, target, target] // weight 5 wall
    const next = run(
      players,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: heavy },
      [mv("t1", target)]
    )

    expect(next.alivePlayers).toEqual(["t2"])
    expect(next.moves.t1).toBe(target)
  })
})

describe("chess pieces: pawns", () => {
  it("staging a side square spends the turn rotating 90°", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt], t2: [at(8, 8)] },
      [mv("t1", at(3, 4))], // side square relative to orientation {dx:1,dy:0}
      { orientation: { t1: { dx: 1, dy: 0 } } }
    )

    expect(next.playerPieces.t1).toEqual([pawnAt]) // did not move
    expect(next.moves.t1).toBe(pawnAt)
    expect(next.orientation.t1).toEqual({ dx: 0, dy: -1 })
    expect(next.playerEnergy.t1).toBe(100) // no movement cost
  })

  it("moves straight forward; diagonal only onto food or a unit; never backward", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const withOrientation = { orientation: { t1: { dx: 1, dy: 0 } } }

    // Straight forward is legal.
    const fwd = run(players, { t1: [pawnAt], t2: [at(8, 8)] }, [mv("t1", at(4, 5))], withOrientation)
    expect(fwd.playerPieces.t1).toEqual([at(4, 5)])

    // Diagonal-forward onto an empty square is illegal — pawn stays.
    const diagEmpty = run(players, { t1: [pawnAt], t2: [at(8, 8)] }, [mv("t1", at(4, 4))], withOrientation)
    expect(diagEmpty.playerPieces.t1).toEqual([pawnAt])

    // Diagonal-forward onto food is legal and eats.
    const diagFood = run(
      players,
      { t1: [pawnAt], t2: [at(8, 8)] },
      [mv("t1", at(4, 4))],
      { ...withOrientation, food: [at(4, 4)] }
    )
    expect(diagFood.playerPieces.t1).toEqual([at(4, 4), at(4, 4)])
    expect(diagFood.playerEnergy.t1).toBe(100)

    // Backward is illegal — pawn stays.
    const back = run(players, { t1: [pawnAt], t2: [at(8, 8)] }, [mv("t1", at(2, 5))], withOrientation)
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
      { orientation: { t1: { dx: 1, dy: 0 }, t2: { dx: -1, dy: 0 } } }
    )

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces.t1).toEqual([at(4, 4), at(4, 4)])
  })

  it("promotes to queen at the configured weight, resetting to weight 1", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    // Eats at (4,5) to reach weight 3 — the threshold — and promotes the same
    // turn, trading the accumulated mass for the crown.
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] }, // weight 2, threshold 3
      [mv("t1", at(4, 5))],
      { orientation: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3 }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    expect(next.playerPieces.t1).toEqual([at(4, 5)]) // weight 1, on its square
    expect(next.moves.t1).toBe(at(4, 5)) // applied move still the square reached
    expect(next.paths?.t1).toEqual([at(4, 5)]) // path of the step it made as a pawn
    expect(next.scores.t1).toBe(1)
    expect(next.alivePlayers).toContain("t1") // weight 1, not 0: still alive

    // Next turn the promoted queen slides like a queen, from weight 1.
    const players2 = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const turn2 = run(
      players2,
      { t1: [at(4, 5)], t2: [at(8, 8)] },
      [mv("t1", at(4, 8))],
      { unitTypes: { t1: "queen", t2: "king" } }
    )
    expect(turn2.playerPieces.t1).toEqual([at(4, 8)])
  })

  it("a pawn already at the threshold promotes to weight 1 without eating", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt, pawnAt, pawnAt], t2: [at(8, 8)] }, // weight 4 >= 3
      [mv("t1", at(4, 5))],
      { orientation: { t1: { dx: 1, dy: 0 } } },
      { pawnPromotionWeight: 3 }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    expect(next.playerPieces.t1).toEqual([at(4, 5)])
    expect(next.playerEnergy.t1).toBe(99) // one step, no eat: normal movement cost
  })

  it("a promoting team's score drops but the team is not eliminated", () => {
    // t1's only unit is the promoting pawn: the team score falls from 3 to 1
    // and the team must still read as alive, with no winner declared.
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] },
      [mv("t1", at(4, 5))],
      { orientation: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3 }
    )

    expect(next.alivePlayers).toEqual(expect.arrayContaining(["t1", "t2"]))
    expect(next.scores.t1).toBe(1)
    expect(next.winners).toEqual([])
    expect(next.clashes.some((c) => c.playerIDs.includes("t1"))).toBe(false)
  })

  it("turn-limit adjudication scores a promoting team at its reset weight", () => {
    // Turn limit hits on this very turn. t1 promotes (weight 3 -> 1); t2's
    // rook holds at weight 2 and therefore wins on score.
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "rook")]
    const pawnAt = at(3, 5)
    const rookAt = at(8, 8)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [rookAt, rookAt] },
      [mv("t1", at(4, 5))],
      { orientation: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3, maxTurns: 1 }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    expect(next.winners.map((w) => w.playerID)).toEqual(["t2"])
    expect(next.winners[0].teamScore).toBe(2)
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
      next.clashes.some((c) => c.reason === REASON.regicide && c.playerIDs.includes("t1#2"))
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

describe("unit orientation (Turn.orientation) — every unit in every game", () => {
  it("a slider that moved faces its unit step direction", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "bishop")]
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(2, 2)] },
      [mv("t1", at(4, 5)), mv("t2", at(5, 5))]
    )

    expect(next.orientation.t1).toEqual({ dx: 1, dy: 0 }) // rook slid right
    expect(next.orientation.t2).toEqual({ dx: 1, dy: 1 }) // bishop slid down-right
  })

  it("a knight faces its exact L-offset", () => {
    const players = [gp("t1", "t1", "A", "knight"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(4, 4)], t2: [at(8, 8)] },
      [mv("t1", at(5, 2))]
    )

    expect(next.playerPieces.t1).toEqual([at(5, 2)])
    expect(next.orientation.t1).toEqual({ dx: 1, dy: -2 })
  })

  it("a pawn's diagonal step leaves its orientation unchanged", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(3, 5)], t2: [at(8, 8)] },
      [mv("t1", at(4, 4))], // diagonal-forward onto food
      { orientation: { t1: { dx: 1, dy: 0 } }, food: [at(4, 4)] }
    )

    expect(next.playerPieces.t1).toEqual([at(4, 4), at(4, 4)])
    expect(next.orientation.t1).toEqual({ dx: 1, dy: 0 }) // not rotated
  })

  it("a unit that holds keeps its previous orientation", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(3, 3)], t2: [at(8, 8)] },
      [], // both stay put
      { orientation: { t1: { dx: 0, dy: 1 }, t2: { dx: -1, dy: 0 } } }
    )

    expect(next.orientation.t1).toEqual({ dx: 0, dy: 1 })
    expect(next.orientation.t2).toEqual({ dx: -1, dy: 0 })
  })

  it("a snake faces head-minus-neck after its move", () => {
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: [at(8, 8)] },
      [mv("t1", at(4, 4))] // head turns upward
    )

    expect(next.playerPieces.t1).toEqual([at(4, 4), at(4, 5), at(3, 5)])
    expect(next.orientation.t1).toEqual({ dx: 0, dy: -1 })
  })

  // Turn 0 at preset squares so spawn-orientation assertions are exact.
  const spawnTurn0 = (
    players: GamePlayer[],
    positions: { [playerID: string]: number }
  ): Turn => {
    const processor = new TeamSnekProcessor({
      setup: mkSetup(twoTeams, players, {
        usePreviewBoard: true,
        presetPlayerPositions: positions,
      }),
      turns: [],
      walls: [],
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: null,
    })
    return processor.firstTurn()
  }

  it("spawn: every unit faces toward the board centre from its type's legal orientation set", () => {
    // Centre is (5,5); every spawn here is clearly off-axis for its type,
    // so the minimal-angle candidate is unique and deterministic.
    const players = [
      gp("p", "t1", "A", "pawn"),
      gp("r", "t1", "B", "rook"),
      gp("b", "t1", "C", "bishop"),
      gp("n", "t2", "A", "knight"),
      gp("k", "t2", "B", "king"),
      gp("s", "t2", "C", "snake"),
    ]
    const turn0 = spawnTurn0(players, {
      p: at(2, 5), // centre vector (3,0)
      r: at(5, 8), // (0,-3)
      b: at(2, 4), // (3,1) → closest diagonal is (1,1)
      n: at(8, 6), // (-3,-1) → closest L-offset is (-2,-1)
      k: at(2, 6), // (3,-1) → (1,0) beats (1,-1)
      s: at(6, 2), // (-1,3) → (0,1)
    })

    expect(turn0.orientation.p).toEqual({ dx: 1, dy: 0 })
    expect(turn0.orientation.r).toEqual({ dx: 0, dy: -1 })
    expect(turn0.orientation.b).toEqual({ dx: 1, dy: 1 })
    expect(turn0.orientation.n).toEqual({ dx: -2, dy: -1 })
    expect(turn0.orientation.k).toEqual({ dx: 1, dy: 0 })
    expect(turn0.orientation.s).toEqual({ dx: 0, dy: 1 })
  })

  it("spawn: ties on a symmetry axis resolve to one of the tied candidates", () => {
    const players = [
      gp("r", "t1", "A", "rook"),
      gp("p", "t1", "B", "pawn"),
      gp("n", "t2", "A", "knight"),
      gp("q", "t2", "B", "queen"),
    ]
    const positions = {
      r: at(2, 2), // exactly on the diagonal from centre: (1,0) ties (0,1)
      p: at(2, 2), // pawns tie-break at random too (no dominant-axis pick)
      n: at(8, 8), // (-3,-3): (-1,-2) ties (-2,-1)
      q: at(5, 5), // exactly at centre: all 8 directions tie
    }
    const turn0 = spawnTurn0(players, positions)

    expect(spawnOrientationCandidates("rook", positions.r, W, W)).toEqual([
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
    ])
    const types: { [id: string]: UnitType } = {
      r: "rook",
      p: "pawn",
      n: "knight",
      q: "queen",
    }
    ;(["r", "p", "n", "q"] as const).forEach((id) => {
      const candidates = spawnOrientationCandidates(types[id], positions[id], W, W)
      expect(candidates.length).toBeGreaterThan(1)
      expect(candidates).toContainEqual(turn0.orientation[id])
    })
    expect(spawnOrientationCandidates("queen", positions.q, W, W)).toHaveLength(8)
  })

  it("promotion keeps the pawn's orientation on the new queen", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    // The promoting step is diagonal-forward ({1,-1}), which a pawn's orientation
    // ignores — the new queen keeps the pawn orientation, not the step direction.
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] }, // weight 2, threshold 3
      [mv("t1", at(4, 4))],
      { orientation: { t1: { dx: 1, dy: 0 } }, food: [at(4, 4)] },
      { pawnPromotionWeight: 3 }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    expect(next.orientation.t1).toEqual({ dx: 1, dy: 0 })
  })

  it("dead units drop out of the orientation map", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "bishop")]
    const blocker = at(4, 5)
    const next = run(
      players,
      { t1: [at(1, 5), at(1, 5), at(1, 5)], t2: [blocker] }, // weight 3 vs 1
      [mv("t1", at(9, 5))],
      { orientation: { t1: { dx: 0, dy: 1 }, t2: { dx: 0, dy: 1 } } }
    )

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.orientation.t1).toEqual({ dx: 1, dy: 0 }) // faced its slide
    expect(next.orientation.t2).toBeUndefined()
  })

  it("snake-only game: spawn orientation points toward the centre from the orthogonals", () => {
    const players = [gp("s1", "t1", "A", "snake"), gp("s2", "t2", "A", "snake")]
    const turn0 = spawnTurn0(players, {
      s1: at(2, 5), // centre vector (3,0) → (1,0)
      s2: at(6, 2), // (-1,3) → (0,1)
    })

    expect(turn0.orientation.s1).toEqual({ dx: 1, dy: 0 })
    expect(turn0.orientation.s2).toEqual({ dx: 0, dy: 1 })
    // unitTypes and paths stay chess-only.
    expect(turn0.unitTypes).toBeUndefined()
    expect(turn0.paths).toBeUndefined()
  })

  it("snake-only game: each turn a snake faces head-minus-neck", () => {
    const players = [gp("s1", "t1", "A", "snake"), gp("s2", "t2", "A", "snake")]
    const next = run(
      players,
      { s1: [at(4, 5), at(3, 5), at(2, 5)], s2: [at(8, 8), at(8, 7), at(8, 6)] },
      [mv("s1", at(4, 4)), mv("s2", at(8, 9))],
      { orientation: { s1: { dx: 1, dy: 0 }, s2: { dx: 0, dy: 1 } } }
    )

    expect(next.playerPieces.s1).toEqual([at(4, 4), at(4, 5), at(3, 5)])
    expect(next.orientation.s1).toEqual({ dx: 0, dy: -1 }) // turned upward
    expect(next.orientation.s2).toEqual({ dx: 0, dy: 1 }) // kept going down
  })

  it("snake-only game: dead units drop out of the orientation map", () => {
    const players = [gp("s1", "t1", "A", "snake"), gp("s2", "t2", "A", "snake")]
    const next = run(
      players,
      { s1: [at(4, 5), at(3, 5), at(2, 5)], s2: [at(1, 1), at(1, 2), at(1, 3)] },
      [mv("s1", at(5, 5)), mv("s2", at(0, 1))] // s2 drives into the wall
    )

    expect(next.alivePlayers).toEqual(["s1"])
    expect(next.orientation.s1).toEqual({ dx: 1, dy: 0 })
    expect(next.orientation.s2).toBeUndefined()
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
    expect(next.playerEnergy.t1).toBe(63)
    expect(next.clashes).toEqual([])
  })

  it("a low-energy slider dies mid-flight on the hazard square that drained it", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(9, 9)] },
      [mv("t1", at(9, 5))],
      { hazards: [at(3, 5), at(5, 5)], playerEnergy: { t1: 50, t2: 100 } },
      { hazardDamage: 30 }
    )

    expect(next.alivePlayers).toEqual(["t2"])
    const clash = next.clashes.find((c) => c.playerIDs.includes("t1"))
    expect(clash!.reason).toBe(REASON.hazard)
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
    expect(next.playerEnergy.t1).toBe(70) // exactly one dose, no movement cost
    expect(next.playerEnergy.t2).toBe(100)
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
    expect(next.playerEnergy.t1).toBe(67)
  })

  it("a king holding still loses no energy across a turn, even at 1 energy", () => {
    const players = [gp("t1", "t1", "A", "king"), gp("t2", "t2", "A", "rook")]
    const next = run(
      players,
      { t1: [at(5, 5)], t2: [at(8, 8)] },
      [mv("t2", at(8, 6))],
      { playerEnergy: { t1: 1, t2: 100 } }
    )

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.playerEnergy.t1).toBe(1) // holding is free
    expect(next.playerEnergy.t2).toBe(98) // rook paid its 2 squares
  })

  it("a snake in a chess game still loses exactly 1 energy per turn", () => {
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "king")]
    const next = run(
      players,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: [at(8, 8)] },
      [mv("t1", at(5, 5))]
    )

    expect(next.playerEnergy.t1).toBe(99)
    expect(next.playerEnergy.t2).toBe(100)
  })
})

describe("configurable per-unit-type max energy", () => {
  it("initial energy honors the per-type config, defaulting missing types to 100", () => {
    const players = [
      gp("t1", "t1", "A", "snake"),
      gp("t1#2", "t1", "B", "knight"),
      gp("t2", "t2", "A", "rook"),
    ]
    const setup = mkSetup(twoTeams, players, {
      maxEnergyPerUnit: { snake: 150, rook: 60 },
    })
    const processor = new TeamSnekProcessor({
      setup,
      turns: [],
      walls: [],
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: null,
    })
    const turn0 = processor.firstTurn()

    expect(turn0.playerEnergy.t1).toBe(150) // configured snake max
    expect(turn0.playerEnergy["t1#2"]).toBe(100) // knight not configured
    expect(turn0.playerEnergy.t2).toBe(60) // configured rook max
  })

  it("snake path: eating restores to the configured snake max", () => {
    // Snake-only game — resolves through the original single-pass path.
    const players = [gp("t1", "t1", "A", "snake"), gp("t2", "t2", "A", "snake")]
    const foodAt = at(5, 5)
    const next = run(
      players,
      { t1: [at(4, 5), at(3, 5), at(2, 5)], t2: [at(8, 8), at(8, 7), at(8, 6)] },
      [mv("t1", foodAt), mv("t2", at(8, 9))],
      { food: [foodAt], playerEnergy: { t1: 10, t2: 100 } },
      { maxEnergyPerUnit: { snake: 40 } }
    )

    expect(next.playerEnergy.t1).toBe(40) // restored to configured max, not 100
    expect(next.playerEnergy.t2).toBe(99) // normal 1/turn drain untouched
  })

  it("chess path: eating restores to the unit's current type's configured max", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const foodAt = at(3, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(8, 8)] },
      [mv("t1", foodAt)],
      { food: [foodAt], playerEnergy: { t1: 20, t2: 100 } },
      { maxEnergyPerUnit: { rook: 55 } }
    )

    expect(next.playerEnergy.t1).toBe(55) // rook max, despite traversal costs
    expect(next.playerEnergy.t2).toBe(100) // king stayed put: spends nothing
  })

  it("pawn promotion clamps carried energy to the queen's configured max", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] }, // weight 2, threshold 3
      [mv("t1", at(4, 5))],
      { orientation: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3, maxEnergyPerUnit: { pawn: 200, queen: 50 } }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    // Ate as a pawn (restored to 200), then clamped to the queen max on promotion.
    expect(next.playerEnergy.t1).toBe(50)
    expect(next.playerPieces.t1).toEqual([at(4, 5)]) // and reset to weight 1
  })

  it("pawn promotion leaves energy alone when it is within the queen's max", () => {
    const players = [gp("t1", "t1", "A", "pawn"), gp("t2", "t2", "A", "king")]
    const pawnAt = at(3, 5)
    const next = run(
      players,
      { t1: [pawnAt, pawnAt], t2: [at(8, 8)] },
      [mv("t1", at(4, 5))],
      { orientation: { t1: { dx: 1, dy: 0 } }, food: [at(4, 5)] },
      { pawnPromotionWeight: 3, maxEnergyPerUnit: { pawn: 80, queen: 500 } }
    )

    expect(next.unitTypes?.t1).toBe("queen")
    // Energy is never topped up by promotion, only clamped: the pawn's 80
    // carries through even though the queen may hold 500.
    expect(next.playerEnergy.t1).toBe(80)
  })

  it("config absent: everything restores to 100 exactly as before", () => {
    const players = [gp("t1", "t1", "A", "rook"), gp("t2", "t2", "A", "king")]
    const foodAt = at(3, 5)
    const next = run(
      players,
      { t1: [at(1, 5)], t2: [at(8, 8)] },
      [mv("t1", foodAt)],
      { food: [foodAt], playerEnergy: { t1: 20, t2: 100 } }
    )

    expect(next.playerEnergy.t1).toBe(100)
    expect(next.playerEnergy.t2).toBe(100) // stationary king spends nothing
  })
})

// Snake bodies are absolute walls with NO friendly exemption: an ally's body
// kills exactly like an enemy's. A slider that dies (or severs) mid-ray stops
// at that square and never reaches — let alone eats at — its staged
// destination. Reported from live play: a bishop appeared to slide over an
// ally's body, eat at the far end and survive.
describe("chess pieces: snake bodies are walls for allies too", () => {
  // Bishop (2,2) -> (6,6) with food waiting on (6,6). The ally snake's
  // POST-move body still covers (4,4), the bishop's second ray square.
  const allyWall = {
    players: [
      gp("b", "t1", "A", "bishop"),
      gp("s", "t1", "B", "snake"),
      gp("e", "t2", "A", "king"),
    ],
    pieces: {
      b: [at(2, 2)],
      s: [at(4, 3), at(4, 4), at(4, 5), at(4, 6)],
      e: [at(9, 9)],
    },
    moves: [mv("b", at(6, 6)), mv("s", at(4, 2))],
  }

  it("a bishop meeting its OWN TEAM's snake body at equal tier dies on that square", () => {
    const next = run(allyWall.players, allyWall.pieces, allyWall.moves, {
      food: [at(6, 6)],
    })

    // Dies on the body square, not at the origin and not at the destination.
    expect(next.alivePlayers.sort()).toEqual(["e", "s"])
    expect(next.playerPieces.b).toBeUndefined()
    expect(next.moves.b).toBe(at(4, 4))
    expect(next.paths?.b).toEqual([at(3, 3), at(4, 4)])

    const clash = next.clashes.find((c) => c.playerIDs.includes("b"))
    expect(clash).toBeDefined()
    expect(clash!.index).toBe(at(4, 4))
    expect(clash!.subStep).toBe(2)
    expect(clash!.reason).toBe(REASON.bodyBlock)

    // It never reaches the food: no eat, no weight, no energy restore.
    expect(next.food).toContain(at(6, 6))
    expect(next.playerEnergy.b).toBeUndefined()
    expect(next.scores.b).toBe(0) // dead: weight never grew
  })

  it("the same holds deep into a long ray, several sub-steps after the ally moved", () => {
    const players = [
      gp("r", "t1", "A", "rook"),
      gp("s", "t1", "B", "snake"),
      gp("e", "t2", "A", "king"),
    ]
    // Rook (1,5) -> (9,5) with food on (9,5). The ally snake runs down column
    // 6 and its post-move body still covers (6,5), reached at sub-step 5.
    const next = run(
      players,
      { r: [at(1, 5)], s: [at(6, 4), at(6, 5), at(6, 6), at(6, 7)], e: [at(9, 9)] },
      [mv("r", at(9, 5)), mv("s", at(6, 3))],
      { food: [at(9, 5)] }
    )

    expect(next.playerPieces.r).toBeUndefined()
    expect(next.moves.r).toBe(at(6, 5))
    expect(next.paths?.r).toEqual([at(2, 5), at(3, 5), at(4, 5), at(5, 5), at(6, 5)])
    const clash = next.clashes.find((c) => c.playerIDs.includes("r"))
    expect(clash!.index).toBe(at(6, 5))
    expect(clash!.subStep).toBe(5)
    expect(next.food).toContain(at(9, 5))
  })

  it("the enemy-body case behaves identically — no friendly/hostile distinction", () => {
    const players = [
      gp("b", "t1", "A", "bishop"),
      gp("s", "t2", "A", "snake"),
      gp("e", "t2", "B", "king"),
    ]
    const next = run(players, allyWall.pieces, allyWall.moves, {
      food: [at(6, 6)],
    })

    expect(next.playerPieces.b).toBeUndefined()
    expect(next.moves.b).toBe(at(4, 4))
    expect(next.paths?.b).toEqual([at(3, 3), at(4, 4)])
    expect(next.food).toContain(at(6, 6))
  })

  it("a strictly higher tier severs an ALLY's body and capture-stops there, short of the food", () => {
    const next = run(allyWall.players, allyWall.pieces, allyWall.moves, {
      food: [at(6, 6)],
      playerInvulnerabilityLevel: { b: 1, s: 0, e: 0 },
    })

    expect(next.alivePlayers.sort()).toEqual(["b", "e", "s"])
    // Post-move ally body is [(4,2),(4,3),(4,4)]; the (4,4) segment is severed.
    expect(next.playerPieces.s).toEqual([at(4, 2), at(4, 3)])
    expect(next.playerPieces.b).toEqual([at(4, 4)]) // weight 1: it did NOT eat
    expect(next.moves.b).toBe(at(4, 4))
    expect(next.paths?.b).toEqual([at(3, 3), at(4, 4)])
    expect(next.food).toContain(at(6, 6))
    expect(next.playerEnergy.b).toBe(98) // 2 squares traversed, no restore
    expect(
      next.clashes.some((c) => c.reason === REASON.sever)
    ).toBe(true)
  })

  it("a body segment that VACATES before the slider arrives lets it through — the legitimate crossing", () => {
    const players = [
      gp("b", "t1", "A", "bishop"),
      gp("s", "t1", "B", "snake"),
      gp("e", "t2", "A", "king"),
    ]
    // Ally snake [head (3,4), tail (4,4)] steps to (2,4): its post-move body
    // is [(2,4),(3,4)], so (4,4) is empty by the time the bishop gets there
    // at sub-step 2. Simultaneous movement — the bishop rightly survives.
    const next = run(
      players,
      { b: [at(2, 2)], s: [at(3, 4), at(4, 4)], e: [at(9, 9)] },
      [mv("b", at(6, 6)), mv("s", at(2, 4))],
      { food: [at(6, 6)] }
    )

    expect(next.alivePlayers.sort()).toEqual(["b", "e", "s"])
    expect(next.moves.b).toBe(at(6, 6))
    expect(next.paths?.b).toEqual([at(3, 3), at(4, 4), at(5, 5), at(6, 6)])
    expect(next.playerPieces.b).toEqual([at(6, 6), at(6, 6)]) // ate: weight 2
    expect(next.playerEnergy.b).toBe(100) // eating restores in full
    expect(next.food).not.toContain(at(6, 6))
  })

  it("a slider that dies on a body never eats food sitting on the death square itself", () => {
    // Food on (4,4) too: the bishop dies there and must not consume it.
    const next = run(allyWall.players, allyWall.pieces, allyWall.moves, {
      food: [at(4, 4), at(6, 6)],
    })

    expect(next.playerPieces.b).toBeUndefined()
    expect(next.food.sort((a, z) => a - z)).toEqual([at(4, 4), at(6, 6)])
  })
})
