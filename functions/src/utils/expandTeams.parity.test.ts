import { Team } from "@shared/types/Game"
import { expandTeams as backendExpandTeams } from "./expandTeams"
// The frontend hand-mirrors this util (the two files carry "do not diverge"
// comments); it cannot live in shared/ because Firebase deploy packages only
// the functions dir and shared/ must stay type-only. This test is the drift
// guard: it imports BOTH copies and fails if their outputs ever differ.
import { expandTeams as frontendExpandTeams } from "../../../frontend/src/utils/expandTeams"

const team = (id: string, name = `name-${id}`, color = "#123456"): Team => ({
  id,
  name,
  color,
})

describe("expandTeams backend/frontend parity", () => {
  const teamSets: { label: string; teams: Team[] }[] = [
    { label: "no teams", teams: [] },
    { label: "one team", teams: [team("alpha")] },
    { label: "two teams", teams: [team("alpha"), team("beta")] },
    {
      label: "many teams",
      teams: [
        team("alpha"),
        team("beta"),
        team("gamma", "Gamma Squad", "#00ff00"),
        team("delta#weird-id"),
        team("epsilon"),
      ],
    },
  ]
  const snakesPerTeamValues = [0, 1, 2, 3, 8]

  for (const { label, teams } of teamSets) {
    for (const snakesPerTeam of snakesPerTeamValues) {
      it(`produces identical output for ${label}, snakesPerTeam=${snakesPerTeam}`, () => {
        const backend = backendExpandTeams(teams, snakesPerTeam)
        const frontend = frontendExpandTeams(teams, snakesPerTeam)
        // Strict deep + order-sensitive equality, and identical serialized
        // form (catches property-order or extra-key drift as well).
        expect(frontend).toStrictEqual(backend)
        expect(JSON.stringify(frontend)).toBe(JSON.stringify(backend))
      })
    }
  }

  const unitMixes = [
    { label: "pure chess", units: { king: 1, queen: 1, rook: 2, bishop: 2, knight: 2, pawn: 4 } },
    { label: "mixed snakes+pieces", units: { snake: 2, knight: 1, pawn: 3 } },
    { label: "kings only", units: { king: 3 } },
    { label: "explicit zeroes", units: { snake: 0, pawn: 2, rook: 0 } },
  ]

  for (const { label, units } of unitMixes) {
    it(`produces identical output for two teams with ${label}`, () => {
      const teams = [team("alpha"), team("beta")]
      const backend = backendExpandTeams(teams, 3, units)
      const frontend = frontendExpandTeams(teams, 3, units)
      expect(frontend).toStrictEqual(backend)
      expect(JSON.stringify(frontend)).toBe(JSON.stringify(backend))
    })
  }

  it("expands unit mixes in fixed type order with sequential letters and typed players", () => {
    for (const fn of [backendExpandTeams, frontendExpandTeams]) {
      const result = fn([team("a")], 3, { snake: 1, king: 1, pawn: 2 })
      expect(result.map((p) => p.id)).toEqual(["a", "a#2", "a#3", "a#4"])
      expect(result.map((p) => p.letter)).toEqual(["A", "B", "C", "D"])
      expect(result.map((p) => p.unitType)).toEqual(["snake", "king", "pawn", "pawn"])
    }
  })

  it("omits unitType entirely in legacy snakesPerTeam mode", () => {
    for (const fn of [backendExpandTeams, frontendExpandTeams]) {
      const result = fn([team("a")], 2)
      result.forEach((p) => expect("unitType" in p).toBe(false))
    }
  })

  it("is order-stable: output follows input team order", () => {
    const teams = [team("z"), team("a"), team("m")]
    for (const fn of [backendExpandTeams, frontendExpandTeams]) {
      const result = fn(teams, 2)
      expect(result.map((p) => p.teamID)).toEqual(["z", "z", "a", "a", "m", "m"])
      expect(result.map((p) => p.id)).toEqual(["z", "z#2", "a", "a#2", "m", "m#2"])
      expect(result.map((p) => p.letter)).toEqual(["A", "B", "A", "B", "A", "B"])
    }
  })
})
