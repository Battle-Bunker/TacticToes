// ── Board fixtures ──────────────────────────────────────────────────────────
//
// Hand-written turn documents, in the wire's own shape, for every outcome the
// board has to be able to draw. They exist so the feedback marks can be looked
// at — by a reader, in a browser, side by side — without a server, a game, or
// the luck of a collision happening to occur while somebody is watching.
//
// They are FIXTURES, not test data dressed up: each one is what the server
// would write for the situation named in its title, and each is rendered
// through the real `turnToBoard` and the real renderer. If a mark looks wrong
// here it is wrong on the live board too.
//
// Dev-only: nothing outside `src/dev` imports this, and the page that does has
// its own dev-server entry (/dev-fixtures.html) that the app never builds.

import {
  Clash,
  GamePlayer,
  GameState,
  Team,
  Turn,
  UnitDeath,
  UnitType,
} from "@shared/types/Game"

const W = 9
const H = 7

/** A full-board index from column and row, rows counted DOWN from the top. */
const at = (col: number, row: number): number => row * W + col

/** The static perimeter every fixture board carries. */
const PERIMETER: number[] = (() => {
  const walls: number[] = []
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      if (row === 0 || row === H - 1 || col === 0 || col === W - 1) {
        walls.push(at(col, row))
      }
    }
  }
  return walls
})()

const TEAMS: Record<string, Team> = {
  red: { id: "red", name: "Red", color: "#d32f2f" },
  blue: { id: "blue", name: "Blue", color: "#1565c0" },
  green: { id: "green", name: "Green", color: "#2e7d32" },
  violet: { id: "violet", name: "Violet", color: "#6a1b9a" },
}

interface UnitSpec {
  id: string
  team: keyof typeof TEAMS
  letter: string
  unitType?: UnitType
}

interface TurnSpec {
  pieces: { [playerID: string]: number[] }
  health?: { [playerID: string]: number }
  deaths?: { [playerID: string]: UnitDeath }
  /** Omitted entirely — as a turn written by a server that forgot the field. */
  omitDeaths?: boolean
  severedCells?: { [playerID: string]: number[] }
  clashes?: Clash[]
  hazards?: number[]
  food?: number[]
  fertileTiles?: number[]
  unitTypes?: { [playerID: string]: UnitType }
  paths?: { [playerID: string]: number[] }
}

const makeTurn = (spec: TurnSpec): Turn => {
  const ids = Object.keys(spec.pieces)
  const turn: Turn = {
    playerHealth: spec.health ?? Object.fromEntries(ids.map((id) => [id, 88])),
    startTime: null,
    endTime: null,
    scores: Object.fromEntries(
      ids.map((id) => [id, spec.pieces[id]?.length ?? 0]),
    ),
    alivePlayers: ids,
    food: spec.food ?? [],
    hazards: spec.hazards ?? [],
    playerPieces: spec.pieces,
    clashes: spec.clashes ?? [],
    deaths: spec.deaths ?? {},
    moves: Object.fromEntries(
      ids.map((id) => [id, spec.pieces[id]?.[0] ?? 0]),
    ),
    winners: [],
    orientation: Object.fromEntries(ids.map((id) => [id, { dx: 1, dy: 0 }])),
    fertileTiles: spec.fertileTiles ?? [],
    unitTypes: spec.unitTypes,
    paths: spec.paths,
    severedCells: spec.severedCells,
  }
  if (spec.omitDeaths) {
    // A turn document that never carried the field at all: the uncertainty
    // case, written the way a server that forgot it would write it.
    delete (turn as Partial<Turn>).deaths
  }
  return turn
}

const makeGame = (units: UnitSpec[], turns: TurnSpec[]): GameState => {
  const teamIDs = [...new Set(units.map((u) => u.team))]
  const gamePlayers: GamePlayer[] = units.map((u) => ({
    id: u.id,
    teamID: TEAMS[u.team].id,
    letter: u.letter,
    unitType: u.unitType,
  }))
  return {
    setup: {
      teams: teamIDs.map((id) => TEAMS[id]),
      gamePlayers,
      snakesPerTeam: 1,
      boardWidth: W,
      boardHeight: H,
      maxTurnTime: 10,
      startRequested: true,
      started: true,
      timeCreated: null,
    },
    turns: turns.map(makeTurn),
    walls: PERIMETER,
    timeCreated: null,
    timeFinished: null,
  }
}

export interface Fixture {
  id: string
  title: string
  /** What the server recorded, in one sentence. */
  blurb: string
  /** What the board must therefore show. */
  expected: string
  gameState: GameState
  /** The square the inspector is opened on for this fixture's dialog shot. */
  inspect: { col: number; row: number }
}

// ── 1. Head-on contest ──────────────────────────────────────────────────────
// Two snakes went for the same square. One died there; the winner is standing
// on the grave, which is the case the old board could not draw at all — an
// occupied cell was taken as proof nobody died on it.
const contest: Fixture = {
  id: "01-contest-head-on",
  title: "1. Head-on contest — victim dead under the survivor",
  blurb:
    "deaths: { blue: cell 31, sub-step 1, contest } · clash: contest, victims [blue], survivor red",
  expected:
    "Death mark at the contested square, in BLUE (the victim), as a corner badge because Red is standing on it. Amber ring around the square.",
  gameState: makeGame(
    [
      { id: "red", team: "red", letter: "A" },
      { id: "blue", team: "blue", letter: "A" },
    ],
    [
      { pieces: { red: [at(5, 3), at(6, 3), at(7, 3)], blue: [at(3, 3), at(2, 3), at(1, 3)] } },
      {
        pieces: { red: [at(4, 3), at(5, 3), at(6, 3), at(7, 3)] },
        health: { red: 74 },
        deaths: { blue: { cell: at(4, 3), subStep: 1, cause: "contest" } },
        clashes: [
          {
            index: at(4, 3),
            subStep: 1,
            kind: "contest",
            playerIDs: ["red", "blue"],
            victimIDs: ["blue"],
            survivorID: "red",
            reason: "Red A (weight 4) outweighed Blue A (weight 3)",
          },
        ],
      },
    ],
  ),
  inspect: { col: 4, row: 3 },
}

// ── 2. Edge exchange, unequal ───────────────────────────────────────────────
// Two units tried to swap squares. The heavier won and finished on the square
// the loser died on — so again the grave is occupied, and again by the killer.
const edgeUnequal: Fixture = {
  id: "02-edge-exchange-unequal",
  title: "2. Edge exchange, unequal — loser dead on its own square",
  blurb:
    "deaths: { blue: cell 32, sub-step 1, edge } · clash: edge, victims [blue], survivor red",
  expected:
    "Death mark in BLUE on the square Blue occupied, with the Red rook that took it standing there.",
  gameState: makeGame(
    [
      { id: "red", team: "red", letter: "A", unitType: "rook" },
      { id: "blue", team: "blue", letter: "A", unitType: "pawn" },
      { id: "green", team: "green", letter: "A" },
    ],
    [
      {
        pieces: {
          red: Array(5).fill(at(4, 3)),
          blue: Array(2).fill(at(5, 3)),
          green: [at(2, 1), at(2, 2)],
        },
        unitTypes: { red: "rook", blue: "pawn" },
      },
      {
        pieces: {
          red: Array(5).fill(at(5, 3)),
          green: [at(3, 1), at(2, 1)],
        },
        health: { red: 91, green: 80 },
        unitTypes: { red: "rook" },
        deaths: { blue: { cell: at(5, 3), subStep: 1, cause: "edge" } },
        clashes: [
          {
            index: at(5, 3),
            subStep: 1,
            kind: "edge",
            playerIDs: ["red", "blue"],
            victimIDs: ["blue"],
            survivorID: "red",
            reason:
              "Red A (rook, weight 5) beat Blue A (pawn, weight 2) in the swap",
          },
        ],
      },
    ],
  ),
  inspect: { col: 5, row: 3 },
}

// ── 3. Edge exchange, tie ───────────────────────────────────────────────────
// Even weights: neither swap survived. One collision, two cells, one record per
// cell — and two deaths, each on the square its own unit stood on.
const edgeTie: Fixture = {
  id: "03-edge-exchange-tie",
  title: "3. Edge exchange, tie — two deaths on two adjacent squares",
  blurb:
    "deaths: { green: cell 30, edge · violet: cell 31, edge } · two edge records, one per cell",
  expected:
    "Two full-size death marks on adjacent squares, each in its OWN victim's colour. Both squares ringed.",
  gameState: makeGame(
    [
      { id: "green", team: "green", letter: "A" },
      { id: "violet", team: "violet", letter: "A" },
      { id: "red", team: "red", letter: "A" },
    ],
    [
      {
        pieces: {
          green: [at(3, 3), at(2, 3), at(1, 3)],
          violet: [at(4, 3), at(5, 3), at(6, 3)],
          red: [at(2, 1), at(1, 1)],
        },
      },
      {
        pieces: { red: [at(3, 1), at(2, 1)] },
        health: { red: 84 },
        deaths: {
          green: { cell: at(3, 3), subStep: 1, cause: "edge" },
          violet: { cell: at(4, 3), subStep: 1, cause: "edge" },
        },
        clashes: [
          {
            index: at(3, 3),
            subStep: 1,
            kind: "edge",
            playerIDs: ["green", "violet"],
            victimIDs: ["green"],
            reason: "Even weights (3 v 3): neither side survived the swap",
          },
          {
            index: at(4, 3),
            subStep: 1,
            kind: "edge",
            playerIDs: ["green", "violet"],
            victimIDs: ["violet"],
            reason: "Even weights (3 v 3): neither side survived the swap",
          },
        ],
      },
    ],
  ),
  inspect: { col: 3, row: 3 },
}

// ── 4. Sever, non-fatal ─────────────────────────────────────────────────────
// The one outcome the old board got flatly wrong: a snake cut short by a
// higher-tier unit is ALIVE, somewhere else, shorter — and the cells it lost
// are empty, which the old renderer read as graves.
const sever: Fixture = {
  id: "04-sever-non-fatal",
  title: "4. Sever, non-fatal — cut cells marked as damage, nobody dead",
  blurb:
    "deaths: {} · severedCells: { blue: [22, 23, 24] } · clash: sever, victims [], survivor red",
  expected:
    "No death mark anywhere. Three BLUE hatched, dashed, bitten cells where Blue's body was cut; the Red rook stopped on the first of them.",
  gameState: makeGame(
    [
      { id: "red", team: "red", letter: "A", unitType: "rook" },
      { id: "blue", team: "blue", letter: "A" },
    ],
    [
      {
        pieces: {
          red: Array(4).fill(at(4, 1)),
          blue: [at(2, 2), at(3, 2), at(4, 2), at(5, 2), at(6, 2)],
        },
        unitTypes: { red: "rook" },
      },
      {
        pieces: {
          red: Array(4).fill(at(4, 2)),
          blue: [at(2, 2), at(3, 2)],
        },
        health: { red: 93, blue: 62 },
        unitTypes: { red: "rook" },
        deaths: {},
        severedCells: { blue: [at(4, 2), at(5, 2), at(6, 2)] },
        clashes: [
          {
            index: at(4, 2),
            subStep: 2,
            kind: "sever",
            playerIDs: ["red", "blue"],
            victimIDs: [],
            survivorID: "red",
            reason:
              "Red A (rook) cut Blue A's body here and stopped; Blue A survives, shortened",
          },
        ],
      },
    ],
  ),
  inspect: { col: 4, row: 2 },
}

// ── 5. Mid-ray starvation ───────────────────────────────────────────────────
// A slider ran out of health part-way along its ray, halted on the square it
// had reached, and was cleared at end of turn. Nobody killed it.
const midRayStarvation: Fixture = {
  id: "05-starvation-mid-ray",
  title: "5. Mid-ray starvation — halted on the third square of its ray",
  blurb:
    "deaths: { red: cell 30, sub-step 3, starvation } · clash: starvation, victims [red]",
  expected:
    "Hollow RED ring with a drained middle and a flat bar, on the square the rook halted on — not the solid disc a killing gets.",
  gameState: makeGame(
    [
      { id: "red", team: "red", letter: "A", unitType: "rook" },
      { id: "blue", team: "blue", letter: "A" },
    ],
    [
      {
        pieces: {
          red: Array(4).fill(at(1, 3)),
          blue: [at(6, 4), at(6, 3), at(6, 2)],
        },
        health: { red: 9, blue: 70 },
        unitTypes: { red: "rook" },
      },
      {
        pieces: { blue: [at(5, 4), at(6, 4), at(6, 3)] },
        health: { blue: 64 },
        deaths: { red: { cell: at(3, 3), subStep: 3, cause: "starvation" } },
        paths: { red: [at(1, 3), at(2, 3), at(3, 3)] },
        clashes: [
          {
            index: at(3, 3),
            subStep: 3,
            kind: "starvation",
            playerIDs: ["red"],
            victimIDs: ["red"],
            reason:
              "Red A ran out of health on the third square of its ray and halted there",
          },
        ],
      },
    ],
  ),
  inspect: { col: 3, row: 3 },
}

// ── 6. Hazard starvation ────────────────────────────────────────────────────
// The same ending by another route: hazard damage emptied the unit's health and
// it went down where it stood, on the hazard square itself.
const hazardStarvation: Fixture = {
  id: "06-starvation-hazard",
  title: "6. Hazard starvation — went down on the hazard square",
  blurb:
    "deaths: { blue: cell 41, sub-step 1, hazard } · clash: hazard, victims [blue]",
  expected:
    "Hollow BLUE starvation mark, legible over the hazard lattice; the cause reads as hazard damage in the inspector.",
  gameState: makeGame(
    [
      { id: "blue", team: "blue", letter: "A" },
      { id: "red", team: "red", letter: "A" },
    ],
    [
      {
        pieces: {
          blue: [at(4, 4), at(3, 4), at(2, 4)],
          red: [at(2, 1), at(3, 1)],
        },
        health: { blue: 24, red: 90 },
        hazards: [at(5, 4), at(6, 4), at(5, 5)],
      },
      {
        pieces: { red: [at(2, 1), at(2, 2)] },
        health: { red: 86 },
        hazards: [at(5, 4), at(6, 4), at(5, 5)],
        deaths: { blue: { cell: at(5, 4), subStep: 1, cause: "hazard" } },
        clashes: [
          {
            index: at(5, 4),
            subStep: 1,
            kind: "hazard",
            playerIDs: ["blue"],
            victimIDs: ["blue"],
            reason:
              "Blue A took 100 hazard damage entering this square and halted there",
          },
        ],
      },
    ],
  ),
  inspect: { col: 5, row: 4 },
}

// ── 7. Corpse pile on a durable cell ────────────────────────────────────────
// Two equal heavies annihilated each other on sub-step A; a lighter unit walked
// into the same square on sub-step B and was destroyed by what was left of it.
// Three deaths, one square, and every one of them has to stay readable.
const corpsePile: Fixture = {
  id: "07-corpse-pile-durable-cell",
  title: "7. Corpse pile — three deaths on one durable square",
  blurb:
    "deaths: { green: 31/1, violet: 31/1, blue: 31/2 } · two contest records, sub-steps 1 and 2",
  expected:
    "One mark split three ways — green, violet, blue — carrying the count 3. The inspector lists all three, each with its own sub-step.",
  gameState: makeGame(
    [
      { id: "green", team: "green", letter: "A", unitType: "queen" },
      { id: "violet", team: "violet", letter: "A", unitType: "queen" },
      { id: "blue", team: "blue", letter: "A", unitType: "pawn" },
      { id: "red", team: "red", letter: "A" },
    ],
    [
      {
        pieces: {
          green: Array(6).fill(at(3, 3)),
          violet: Array(6).fill(at(5, 3)),
          blue: Array(2).fill(at(4, 1)),
          red: [at(2, 5), at(1, 5)],
        },
        unitTypes: { green: "queen", violet: "queen", blue: "pawn" },
      },
      {
        pieces: { red: [at(3, 5), at(2, 5)] },
        health: { red: 88 },
        deaths: {
          green: { cell: at(4, 3), subStep: 1, cause: "contest" },
          violet: { cell: at(4, 3), subStep: 1, cause: "contest" },
          blue: { cell: at(4, 3), subStep: 2, cause: "contest" },
        },
        clashes: [
          {
            index: at(4, 3),
            subStep: 1,
            kind: "contest",
            playerIDs: ["green", "violet"],
            victimIDs: ["green", "violet"],
            reason: "Equal weights (6 v 6): both queens were destroyed",
          },
          {
            index: at(4, 3),
            subStep: 2,
            kind: "contest",
            playerIDs: ["blue"],
            victimIDs: ["blue"],
            reason:
              "Blue A entered the durable collision square a sub-step later and was destroyed by it",
          },
        ],
      },
    ],
  ),
  inspect: { col: 4, row: 3 },
}

// ── 8. Missing fields ───────────────────────────────────────────────────────
// Three different holes in one turn: no death registry at all while a unit left
// the board, a record of a kind this board has never heard of, and a record
// that never says who died. None of them may become a guess, and none of them
// may crash the board.
const incompleteRecord: Fixture = {
  id: "08-missing-fields-uncertainty",
  title: "8. Missing fields — the board says it does not know",
  blurb:
    "no deaths field while Blue vanished · clash kind \"chainReaction\" · clash with no victimIDs",
  expected:
    "Muted dashed \"?\" marks — never a team colour, never a death — at Blue's last-known square, at the unknown-kind square, and as a corner badge on the square whose record names no victim. Clash rings on those squares turn grey.",
  gameState: makeGame(
    [
      { id: "red", team: "red", letter: "A" },
      { id: "blue", team: "blue", letter: "A" },
    ],
    [
      {
        pieces: {
          red: [at(2, 2), at(1, 2)],
          blue: [at(3, 3), at(2, 3)],
        },
      },
      {
        pieces: { red: [at(4, 2), at(3, 2)] },
        health: { red: 77 },
        omitDeaths: true,
        clashes: [
          {
            index: at(5, 4),
            subStep: 1,
            kind: "chainReaction" as Clash["kind"],
            playerIDs: ["red", "blue"],
            victimIDs: [],
            reason: "chain reaction",
          },
          {
            index: at(4, 2),
            subStep: 1,
            kind: "contest",
            playerIDs: ["red", "blue"],
            victimIDs: undefined as unknown as string[],
            reason: "contested",
          },
        ],
      },
    ],
  ),
  inspect: { col: 5, row: 4 },
}

export const FIXTURES: Fixture[] = [
  contest,
  edgeUnequal,
  edgeTie,
  sever,
  midRayStarvation,
  hazardStarvation,
  corpsePile,
  incompleteRecord,
]

/** The turn every fixture is displayed at: the second, so a "before" exists. */
export const FIXTURE_TURN_INDEX = 1

export const BOARD_WIDTH = W
export const BOARD_HEIGHT = H
