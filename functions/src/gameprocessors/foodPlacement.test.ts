import { GamePlayer, GameState } from "@shared/types/Game"
import { TeamSnekProcessor } from "./TeamSnekProcessor"
import { mkGameState, mkSetup } from "./playTurn"

jest.mock("firebase/firestore", () => ({
  Timestamp: {
    now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
    fromMillis: jest.fn((ms: number) => ({
      seconds: Math.floor(ms / 1000),
      nanoseconds: 0,
      toMillis: () => ms,
    })),
  },
}))

/**
 * Turn 0's food, pinned.
 *
 * Food placement is the one part of the board build nothing else tests:
 * `checkSnakeStartLocations.test.ts` checks unit positions, spawn parity and
 * slice assignment, and stops there. The golden replays never call
 * `firstTurn` at all. So the centre-food rule, the per-unit diagonal rule and
 * the "what counts as occupied" set behind both were free to change silently.
 *
 * Every case below drives `firstTurn()` with preset positions and preset
 * hazards, which makes the whole build deterministic: no randomness reaches
 * food, so the exact array can be asserted rather than a property of it.
 * Board is 10x10, so the walls are the perimeter and cell 55 is the centre.
 */
describe("turn 0 food placement", () => {
  const WIDTH = 10
  const HEIGHT = 10

  const mkState = (
    positions: { [playerID: string]: number },
    hazards: number[] = [],
  ): GameState => {
    const ids = Object.keys(positions)
    const gamePlayers: GamePlayer[] = ids.map((id) => ({
      id,
      teamID: id,
      letter: "A",
    }))
    return mkGameState(
      mkSetup({
        teams: ids.map((id) => ({ id, name: id, color: "#ff0000" })),
        gamePlayers,
        boardWidth: WIDTH,
        boardHeight: HEIGHT,
        maxTurnTime: 10,
        usePreviewBoard: true,
        presetPlayerPositions: positions,
        ...(hazards.length > 0 ? { presetHazards: hazards } : {}),
      }),
      [],
    )
  }

  const foodFor = (
    positions: { [playerID: string]: number },
    hazards: number[] = [],
  ): number[] => new TeamSnekProcessor(mkState(positions, hazards)).firstTurn().food

  it("puts one food on the centre cell and one on each unit's down-right diagonal", () => {
    // p1 at (2,2), p2 at (7,7); centre (5,5)=55 is free.
    expect(foodFor({ p1: 22, p2: 77 })).toEqual([55, 33, 88])
  })

  it("falls back to the first free cell in board order when the centre is taken", () => {
    // p2 sits on the centre, so the centre food goes to cell 11 — the first
    // cell that is neither wall nor unit.
    expect(foodFor({ p1: 22, p2: 55 })).toEqual([11, 33, 66])
  })

  it("tries the diagonals in order and places nothing when none is free", () => {
    // p1 at (1,1): its down-right diagonal (2,2) is p2, and its other three
    // are all outside the walls, so p1 gets no food of its own.
    expect(foodFor({ p1: 11, p2: 22 })).toEqual([55, 33])
  })

  it("does not place food on a hazard", () => {
    // p1's first diagonal (3,3)=33 is a hazard, so it takes the next one in
    // the fixed order, up-right (3,1)=13.
    expect(foodFor({ p1: 22 }, [33])).toEqual([55, 13])
  })

  it("never places food on a wall, a hazard, a unit, or twice on one cell", () => {
    const hazards = [33, 44, 66]
    const positions = { p1: 22, p2: 77, p3: 24 }
    const food = foodFor(positions, hazards)
    const walls = new TeamSnekProcessor(mkState(positions, hazards)).getWalls()
    food.forEach((cell) => {
      expect(walls).not.toContain(cell)
      expect(hazards).not.toContain(cell)
      expect(Object.values(positions)).not.toContain(cell)
    })
    expect(new Set(food).size).toBe(food.length)
  })
})
