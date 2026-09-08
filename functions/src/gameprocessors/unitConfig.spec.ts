// The per-unit-type configuration group: its defaults, its one reader, and the
// weight it gives a unit at creation.
//
// The group is the single shape the three numbers a kind is configured with
// travel in — food energy, max energy, starting weight — and `unitConfigOf` is
// the only place a game document is read for them. That matters most for a
// document written BEFORE the group existed: it states its settings as a
// `maxEnergyPerUnit` map and a global `foodEnergy`, and it has to keep playing
// exactly as it did.

import { StartedGameSetup } from "@shared/types/Game"
import {
  DEFAULT_FOOD_ENERGY,
  DEFAULT_MAX_ENERGY,
  DEFAULT_STARTING_WEIGHT,
  everyUnitType,
  unitConfigOf,
  unitTypeConfig,
} from "./engine/unitConfig"
import { BoardPlacement } from "./placement"

describe("the per-unit-type configuration group", () => {
  it("defaults to today's numbers for every kind", () => {
    expect(unitTypeConfig(undefined, "snake")).toEqual({
      foodEnergy: DEFAULT_FOOD_ENERGY,
      maxEnergy: DEFAULT_MAX_ENERGY,
      startingWeight: 3,
    })
    expect(unitTypeConfig({}, "rook")).toEqual({
      foodEnergy: 100,
      maxEnergy: 100,
      startingWeight: 1,
    })
  })

  it("fills a group's absent fields with the defaults, not with each other", () => {
    expect(unitTypeConfig({ pawn: { maxEnergy: 30 } }, "pawn")).toEqual({
      foodEnergy: 100,
      maxEnergy: 30,
      startingWeight: 1,
    })
  })

  it("reads a document written before the group existed", () => {
    // The two settings the group replaced, exactly as an in-flight game
    // carries them: a per-type max map and one global food energy.
    const config = unitConfigOf({ maxEnergyPerUnit: { snake: 150, rook: 60 }, foodEnergy: 20 })

    expect(unitTypeConfig(config, "snake")).toEqual({
      foodEnergy: 20,
      maxEnergy: 150,
      startingWeight: 3,
    })
    expect(unitTypeConfig(config, "rook").maxEnergy).toBe(60)
    // A kind the old map did not name still takes the default max, and the
    // global food energy still reaches it.
    expect(unitTypeConfig(config, "knight")).toEqual({
      foodEnergy: 20,
      maxEnergy: 100,
      startingWeight: 1,
    })
  })

  it("lets the group win field by field over the fields it replaced", () => {
    const config = unitConfigOf({
      unitConfig: { pawn: { maxEnergy: 40 } },
      maxEnergyPerUnit: { pawn: 999, queen: 70 },
      foodEnergy: 15,
    })

    expect(unitTypeConfig(config, "pawn")).toEqual({
      foodEnergy: 15,
      maxEnergy: 40,
      startingWeight: 1,
    })
    expect(unitTypeConfig(config, "queen").maxEnergy).toBe(70)
  })

  it("states nothing a document did not", () => {
    expect(unitConfigOf(undefined)).toEqual({})
    expect(unitConfigOf({})).toEqual({})
  })

  it("spreads one group over every kind", () => {
    const config = everyUnitType({ foodEnergy: 5 })
    expect(unitTypeConfig(config, "king").foodEnergy).toBe(5)
    expect(unitTypeConfig(config, "snake").maxEnergy).toBe(DEFAULT_MAX_ENERGY)
  })
})

describe("starting weight, where a unit is created", () => {
  const setup = (unitConfig?: StartedGameSetup["unitConfig"]): StartedGameSetup => ({
    teams: [{ id: "t1", name: "T1", color: "#fff" }],
    snakesPerTeam: 1,
    gamePlayers: [
      { id: "s", teamID: "t1", letter: "A", unitType: "snake" },
      { id: "r", teamID: "t1", letter: "B", unitType: "rook" },
    ],
    boardWidth: 11,
    boardHeight: 11,
    maxTurnTime: 10,
    startRequested: false,
    started: true,
    timeCreated: 0,
    ...(unitConfig ? { unitConfig } : {}),
  })

  const occupancy = (config?: StartedGameSetup["unitConfig"]) =>
    new BoardPlacement(setup(config)).buildBoard({ positions: { s: 24, r: 26 } }).playerPieces

  it("spawns a snake as a stacked triple and a piece as one square", () => {
    expect(occupancy()).toEqual({ s: [24, 24, 24], r: [26] })
    expect(DEFAULT_STARTING_WEIGHT.snake).toBe(3)
  })

  it("spawns each kind at the weight its own group configures", () => {
    expect(occupancy({ snake: { startingWeight: 1 }, rook: { startingWeight: 4 } })).toEqual({
      s: [24],
      r: [26, 26, 26, 26],
    })
  })
})
