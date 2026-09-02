// THE ADJUDICATION CORPUS — the gate the winner rule is measured against.
//
// `19-ENGINE-SPEC.md` moves adjudication (who won, and on which board) out of
// TeamSnekProcessor and into the vendorable engine, because it is a rule like
// any other: three implementations already existed — the server's, the
// harness's placement logic and the bot's terminal model — and they disagreed
// about the branch nobody plays through often, the one where every remaining
// team dies on the same turn.
//
// That branch is why this file is a corpus rather than a unit test. The rule
// has five outcomes (continue, last team standing, the turn limit with a
// winner, the turn limit drawn, and the mutual wipe settled on the PREVIOUS
// committed board) and each one is reachable two ways. So every branch is
// played as a real game through `applyMoves`, and the winner rows the server
// writes to the wire are pinned here exactly.
//
// The pins are the before-picture. Once `adjudicate` is exported, the same
// corpus asks the engine the same question directly, off the same wire data,
// and the two answers must agree row for row — which is the first time the
// rule has ever been checkable against a second caller.

import { Timestamp } from "firebase-admin/firestore"
import {
  GamePlayer,
  GameState,
  Move,
  StartedGameSetup,
  Team,
  Turn,
  Winner,
} from "@shared/types/Game"
import { DEFAULT_MAX_TURNS, TeamSnekProcessor } from "./TeamSnekProcessor"

// 9x9 board: index = y * 9 + x, perimeter is wall (interior 1..7).
const W = 9
const at = (x: number, y: number): number => y * W + x

const teamsOf = (ids: string[]): Team[] =>
  ids.map((id, i) => ({ id, name: `Team ${id}`, color: `#00000${i}` }))

const gp = (
  id: string,
  teamID: string,
  letter: string,
  unitType?: GamePlayer["unitType"],
): GamePlayer => ({ id, teamID, letter, ...(unitType ? { unitType } : {}) })

const mkSetup = (
  players: GamePlayer[],
  overrides: Partial<StartedGameSetup> = {},
): StartedGameSetup => ({
  teams: teamsOf(Array.from(new Set(players.map((p) => p.teamID)))),
  snakesPerTeam: 1,
  gamePlayers: players,
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
  overrides: Partial<Turn> = {},
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
    deaths: {},
    moves: {},
    winners: [],
    ...overrides,
    orientation: {
      ...Object.fromEntries(ids.map((id) => [id, { dx: 1, dy: 0 }])),
      ...overrides.orientation,
    },
  }
}

/**
 * `turnsPlayed` is how many turns the game has already committed — the number
 * the turn limit is measured against, and the length of the history the
 * mutual-wipe branch reaches back into. Only the last turn is ever read, so
 * the rest of the history is padded with it.
 */
const mkGameState = (
  setup: StartedGameSetup,
  turn: Turn,
  turnsPlayed: number,
): GameState => ({
  setup,
  turns: [...Array(turnsPlayed - 1).fill(turn), turn],
  walls: [],
  timeCreated: Timestamp.fromMillis(0),
  timeFinished: null,
})

const mv = (playerID: string, move: number): Move => ({
  gameID: "adjudication",
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(0),
})

// ── the corpus ─────────────────────────────────────────────────────────────

interface Fixture {
  /** What branch this row exists to reach. */
  readonly name: string
  readonly players: GamePlayer[]
  readonly pieces: { [playerID: string]: number[] }
  /** playerID → staged cell. */
  readonly moves: { [playerID: string]: number }
  readonly turnOverrides?: Partial<Turn>
  readonly setupOverrides?: Partial<StartedGameSetup>
  /** Turns already committed when this one is applied. Default 1. */
  readonly turnsPlayed?: number
  /** The winner rows the server writes. Pinned before adjudication moves. */
  readonly winners: Winner[]
}

/** Two snakes, one per team, in the same opening every snake row starts from. */
const SNAKE_PLAYERS = [gp("t1", "t1", "A"), gp("t2", "t2", "A")]
const OPENING = {
  t1: [at(3, 3), at(2, 3), at(1, 3)],
  t2: [at(1, 1), at(2, 1), at(3, 1)],
}
/** The same opening with t1 a weight heavier, its tail doubled. */
const HEAVY_OPENING = {
  t1: [at(3, 3), at(2, 3), at(1, 3), at(1, 3)],
  t2: [at(1, 1), at(2, 1), at(3, 1)],
}
/** t1 stages its own neck (fatal); t2 stages the top wall (fatal). */
const MUTUAL_WIPE_MOVES = { t1: at(2, 3), t2: at(1, 0) }
/** Both step into open squares and live. */
const QUIET_MOVES = { t1: at(4, 3), t2: at(1, 2) }

const CORPUS: Fixture[] = [
  {
    name: "the last team standing wins outright, below any limit",
    players: SNAKE_PLAYERS,
    pieces: OPENING,
    moves: { t1: at(4, 3), t2: at(1, 0) },
    winners: [
      {
        playerID: "t1",
        score: 3,
        winningSquares: [31, 30, 29],
        teamID: "t1",
        teamScore: 3,
      },
    ],
  },
  {
    name: "nobody wins while two teams stand and the limit is far off",
    players: SNAKE_PLAYERS,
    pieces: OPENING,
    moves: QUIET_MOVES,
    turnsPlayed: DEFAULT_MAX_TURNS - 1,
    winners: [],
  },
  {
    name: "the turn limit picks the heavier team when the weights differ",
    players: SNAKE_PLAYERS,
    pieces: OPENING,
    moves: QUIET_MOVES,
    turnOverrides: { food: [at(4, 3)] },
    setupOverrides: { maxTurns: 1 },
    winners: [
      {
        playerID: "t1",
        score: 4,
        winningSquares: [31, 30, 29, 29],
        teamID: "t1",
        teamScore: 4,
      },
    ],
  },
  {
    name: "the turn limit draws between teams of equal weight",
    players: SNAKE_PLAYERS,
    pieces: OPENING,
    moves: QUIET_MOVES,
    setupOverrides: { maxTurns: 1 },
    winners: [
      {
        playerID: "t1",
        score: 3,
        winningSquares: [31, 30, 29],
        teamID: "t1",
        teamScore: 3,
      },
      {
        playerID: "t2",
        score: 3,
        winningSquares: [19, 10, 11],
        teamID: "t2",
        teamScore: 3,
      },
    ],
  },
  {
    name: "an absent maxTurns adjudicates on arrival at the default limit",
    players: SNAKE_PLAYERS,
    pieces: OPENING,
    moves: QUIET_MOVES,
    turnOverrides: { food: [at(4, 3)] },
    turnsPlayed: DEFAULT_MAX_TURNS,
    winners: [
      {
        playerID: "t1",
        score: 4,
        winningSquares: [31, 30, 29, 29],
        teamID: "t1",
        teamScore: 4,
      },
    ],
  },
  {
    name: "an explicit maxTurns: null never ends on the count",
    players: SNAKE_PLAYERS,
    pieces: OPENING,
    moves: QUIET_MOVES,
    turnOverrides: { food: [at(4, 3)] },
    setupOverrides: { maxTurns: null },
    turnsPlayed: DEFAULT_MAX_TURNS * 2,
    winners: [],
  },
  {
    name: "a mutual wipe settles on the previous board, which t1 led",
    players: SNAKE_PLAYERS,
    pieces: HEAVY_OPENING,
    moves: MUTUAL_WIPE_MOVES,
    winners: [
      {
        playerID: "t1",
        score: 4,
        winningSquares: [30, 29, 28, 28],
        teamID: "t1",
        teamScore: 4,
      },
    ],
  },
  {
    name: "a mutual wipe the previous board had tied draws",
    players: SNAKE_PLAYERS,
    pieces: {
      t1: [at(3, 3), at(2, 3), at(1, 3), at(1, 3)],
      t2: [at(1, 1), at(2, 1), at(3, 1), at(3, 1)],
    },
    moves: MUTUAL_WIPE_MOVES,
    winners: [
      {
        playerID: "t1",
        score: 4,
        winningSquares: [30, 29, 28, 28],
        teamID: "t1",
        teamScore: 4,
      },
      {
        playerID: "t2",
        score: 4,
        winningSquares: [10, 11, 12, 12],
        teamID: "t2",
        teamScore: 4,
      },
    ],
  },
  {
    name: "a mutual wipe ON the limit turn still settles on the previous board",
    players: SNAKE_PLAYERS,
    pieces: HEAVY_OPENING,
    moves: MUTUAL_WIPE_MOVES,
    setupOverrides: { maxTurns: 1 },
    winners: [
      {
        playerID: "t1",
        score: 4,
        winningSquares: [30, 29, 28, 28],
        teamID: "t1",
        teamScore: 4,
      },
    ],
  },
  {
    name: "regicide ends a team, and the survivor wins as the last one standing",
    players: [
      gp("t1", "t1", "A", "king"),
      gp("t1#2", "t1", "B", "rook"),
      gp("t2", "t2", "A", "queen"),
    ],
    pieces: {
      t1: [at(5, 5)],
      "t1#2": [at(2, 7)],
      t2: [at(5, 2), at(5, 2), at(5, 2)],
    },
    moves: { t2: at(5, 5) },
    winners: [
      {
        playerID: "t2",
        score: 3,
        winningSquares: [50, 50, 50],
        teamID: "t2",
        teamScore: 3,
      },
    ],
  },
  {
    name: "a third team's death leaves two standing, so the game continues",
    players: [gp("t1", "t1", "A"), gp("t2", "t2", "A"), gp("t3", "t3", "A")],
    pieces: {
      t1: [at(3, 3), at(2, 3), at(1, 3)],
      t2: [at(1, 1), at(2, 1), at(3, 1)],
      t3: [at(7, 7), at(6, 7), at(5, 7)],
    },
    moves: { t1: at(4, 3), t2: at(1, 2), t3: at(7, 8) },
    winners: [],
  },
  {
    name: "the turn limit weighs the dead team at zero alongside the living",
    players: [gp("t1", "t1", "A"), gp("t2", "t2", "A"), gp("t3", "t3", "A")],
    pieces: {
      t1: [at(3, 3), at(2, 3), at(1, 3)],
      t2: [at(1, 1), at(2, 1), at(3, 1)],
      t3: [at(7, 7), at(6, 7), at(5, 7)],
    },
    moves: { t1: at(4, 3), t2: at(1, 2), t3: at(7, 8) },
    turnOverrides: { food: [at(4, 3)] },
    setupOverrides: { maxTurns: 1 },
    winners: [
      {
        playerID: "t1",
        score: 4,
        winningSquares: [31, 30, 29, 29],
        teamID: "t1",
        teamScore: 4,
      },
    ],
  },
]

/** Plays the fixture's one turn and returns the turn the server produced. */
const play = (fixture: Fixture): { produced: Turn; before: Turn } => {
  const setup = mkSetup(fixture.players, fixture.setupOverrides)
  const before = mkTurn(fixture.pieces, fixture.turnOverrides)
  const state = mkGameState(setup, before, fixture.turnsPlayed ?? 1)
  const processor = new TeamSnekProcessor(state)
  const moves = Object.entries(fixture.moves).map(([id, cell]) => mv(id, cell))
  return { produced: processor.applyMoves(before, moves), before }
}

describe("adjudication corpus: the server's winner rows", () => {
  it.each(CORPUS.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    expect(play(fixture).produced.winners).toEqual(fixture.winners)
  })
})

describe("adjudication corpus: coverage", () => {
  // A corpus is only a gate if it reaches the branches. These four are the
  // ones a re-implementation gets wrong: the draw, the wipe, the limit and
  // the game that simply carries on.
  const played = CORPUS.map((f) => ({ fixture: f, turn: play(f).produced }))

  it("plays a game out to every ending the rule has", () => {
    const drawn = played.filter(
      (p) => new Set(p.turn.winners.map((w) => w.teamID)).size > 1,
    )
    const wiped = played.filter((p) => p.turn.alivePlayers.length === 0)
    const continues = played.filter((p) => p.turn.winners.length === 0)
    const decided = played.filter(
      (p) => p.turn.winners.length > 0 && p.turn.alivePlayers.length > 0,
    )

    expect(drawn.length).toBeGreaterThan(0)
    expect(wiped.length).toBe(3)
    expect(continues.length).toBe(3)
    expect(decided.length).toBeGreaterThan(0)
  })

  it("settles every wipe on a board nobody was standing on", () => {
    // The branch three implementations disagreed about: the winner's squares
    // are cells the settled board does not contain, because they are the
    // previous committed turn's.
    played
      .filter((p) => p.turn.alivePlayers.length === 0)
      .forEach((p) => {
        expect(p.turn.playerPieces).toEqual({})
        expect(p.turn.winners.length).toBeGreaterThan(0)
        p.turn.winners.forEach((w) => expect(w.winningSquares.length).toBe(4))
      })
  })
})
