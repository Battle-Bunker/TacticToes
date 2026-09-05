// ONE SCENARIO RUNNER — the test scaffolding shared by every processor test
// file (turnEngine.spec.ts, chessPieces.test.ts, adjudication.spec.ts,
// potions.test.ts, TeamSnekProcessor.spec.ts, headToHead.test.ts,
// processTurn.test.ts, checkSnakeStartLocations.test.ts,
// foodPlacement.test.ts, and the perimeter builders in queries.spec.ts,
// resolveTurn.spec.ts and settlePartial.spec.ts).
//
// Every one of those files built the same four things by hand: a
// `StartedGameSetup`, a `Turn`, a `GameState` and a `Move`. This is the one
// body, lifted verbatim from `turnEngine.spec.ts` where the constructors
// disagreed least. Test helper, not production code — outside `engine/`, and
// named so Jest's default `testMatch` ignores it, same as `goldenReplay.ts`.

import { Timestamp } from "firebase-admin/firestore"
import {
  GamePlayer,
  GameState,
  Move,
  StartedGameSetup,
  Team,
  Turn,
} from "@shared/types/Game"
import { expandTeams } from "../utils/expandTeams"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

export const DEFAULT_TEAMS: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#0000ff" },
]

export const mkTeams = (...ids: string[]): Team[] =>
  ids.map((id) => ({ id, name: id, color: "#ff0000" }))

export const gp = (
  id: string,
  teamID: string,
  letter: string,
  unitType?: GamePlayer["unitType"]
): GamePlayer => ({ id, teamID, letter, ...(unitType ? { unitType } : {}) })

export const mv = (playerID: string, move: number, atMillis = 0): Move => ({
  gameID: "game1",
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(atMillis),
})

/** playerID → cell, one square per unit — for a Fixture's `moves` map. */
export const mvOf = (moves: { [playerID: string]: number }): Move[] =>
  Object.entries(moves).map(([id, cell]) => mv(id, cell))

export const mkSetup = (
  overrides: Partial<StartedGameSetup> = {}
): StartedGameSetup => {
  const teams = overrides.teams ?? DEFAULT_TEAMS
  return {
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
  }
}

export const mkTurn = (
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
    // Every unit carries an orientation; tests override the units whose
    // orientation matters.
    orientation: {
      ...Object.fromEntries(ids.map((id) => [id, { dx: 1, dy: 0 }])),
      ...overrides.orientation,
    },
  }
}

/**
 * `turnsPlayed` is how many turns the game has already committed. Only the
 * last turn is ever read by the tests that use this form, so the rest of the
 * history is padded with it. Pass an explicit `Turn[]` (a real stream) when
 * the history itself matters.
 */
export const mkGameState = (
  setup: StartedGameSetup,
  turns: Turn | Turn[],
  turnsPlayed = 1
): GameState => ({
  setup,
  turns: Array.isArray(turns)
    ? turns
    : [...Array(turnsPlayed - 1).fill(turns), turns],
  walls: [],
  timeCreated: Timestamp.fromMillis(0),
  timeFinished: null,
})

/** All cells on the w x h perimeter, sorted ascending. */
export const perimeter = (w: number, h: number): number[] => {
  const walls = new Set<number>()
  for (let x = 0; x < w; x++) {
    walls.add(x)
    walls.add((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    walls.add(y * w)
    walls.add(y * w + (w - 1))
  }
  return Array.from(walls).sort((a, b) => a - b)
}

/** Curried index-of, so a file states its board width once: `at(W)(x, y)`. */
export const at =
  (w: number) =>
  (x: number, y: number): number =>
    y * w + x

export interface Scenario {
  players: GamePlayer[]
  pieces: { [playerID: string]: number[] }
  moves: Move[]
  turn?: Partial<Turn>
  setup?: Partial<StartedGameSetup>
  turnsBefore?: number
}

/** Verbatim from turnEngine.spec.ts: build a scenario and play its turn. */
export const play = (scenario: Scenario): Turn => {
  const ids = Object.keys(scenario.pieces)
  const teamIDs = Array.from(new Set(scenario.players.map((p) => p.teamID)))
  const turn: Turn = {
    playerEnergy: Object.fromEntries(ids.map((id) => [id, 100])),
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
    teams: mkTeams(...teamIDs),
    snakesPerTeam: 1,
    gamePlayers: scenario.players,
    boardWidth: 11,
    boardHeight: 11,
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
