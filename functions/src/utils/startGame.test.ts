import { GameSetup, Team } from "@shared/types/Game"
import { Timestamp } from "firebase-admin/firestore"
import { firstTurnDurationSeconds, reasonNotToStart } from "./startGame"

const teams: Team[] = [
  { id: "centaur1", name: "Centaur One", color: "#ff0000" },
  { id: "centaur2", name: "Centaur Two", color: "#0000ff" },
]

const baseSetup = (overrides: Partial<GameSetup> = {}): GameSetup => ({
  teams,
  snakesPerTeam: 3,
  boardWidth: 11,
  boardHeight: 11,
  maxTurnTime: 10,
  firstTurnTime: 30,
  startRequested: true,
  started: false,
  timeCreated: Timestamp.fromMillis(0),
  ...overrides,
})

describe("reasonNotToStart (startRequested)", () => {
  const trigger = { kind: "startRequested" } as const

  it("allows a start-requested game with two teams", () => {
    expect(reasonNotToStart(baseSetup(), trigger)).toBeNull()
  })

  it("refuses a game that has already started", () => {
    expect(reasonNotToStart(baseSetup({ started: true }), trigger)).toMatch(/already started/)
  })

  it("refuses when start has not been requested", () => {
    expect(reasonNotToStart(baseSetup({ startRequested: false }), trigger)).toMatch(
      /not requested/
    )
  })

  it("refuses fewer than two teams", () => {
    expect(reasonNotToStart(baseSetup({ teams: [teams[0]] }), trigger)).toMatch(
      /fewer than 2 teams/
    )
    expect(reasonNotToStart(baseSetup({ teams: [] }), trigger)).toMatch(/fewer than 2 teams/)
  })

  it("rejects boards too small for teams × snakesPerTeam", () => {
    // 5×5 board has a 3×3 interior = 9 spawn cells; 2 teams × 5 snakes = 10.
    expect(
      reasonNotToStart(
        baseSetup({ boardWidth: 5, boardHeight: 5, snakesPerTeam: 5 }),
        trigger
      )
    ).toMatch(/board too small/)
    expect(
      reasonNotToStart(
        baseSetup({ boardWidth: 5, boardHeight: 5, snakesPerTeam: 4 }),
        trigger
      )
    ).toBeNull()
  })

  it("leaves tournament games to the scheduler", () => {
    expect(reasonNotToStart(baseSetup({ tournamentMode: true }), trigger)).toMatch(
      /tournament/
    )
  })
})

describe("reasonNotToStart (scheduled)", () => {
  const scheduledMillis = 1_700_000_000_000
  const tournamentSetup = (overrides: Partial<GameSetup> = {}) =>
    baseSetup({
      tournamentMode: true,
      startRequested: false,
      scheduledStartTime: Timestamp.fromMillis(scheduledMillis),
      ...overrides,
    })

  it("allows a scheduled tournament game whose time matches", () => {
    const trigger = {
      kind: "scheduled",
      expectedScheduledStartMillis: scheduledMillis,
    } as const
    expect(reasonNotToStart(tournamentSetup(), trigger)).toBeNull()
  })

  it("refuses when the scheduled time has since moved", () => {
    const trigger = {
      kind: "scheduled",
      expectedScheduledStartMillis: scheduledMillis - 60_000,
    } as const
    expect(reasonNotToStart(tournamentSetup(), trigger)).toMatch(/stale task/)
  })

  it("refuses when tournament mode was turned off", () => {
    const trigger = { kind: "scheduled" } as const
    expect(reasonNotToStart(tournamentSetup({ tournamentMode: false }), trigger)).toMatch(
      /tournament mode not active/
    )
  })

  it("refuses a game that has already started", () => {
    const trigger = { kind: "scheduled" } as const
    expect(reasonNotToStart(tournamentSetup({ started: true }), trigger)).toMatch(
      /already started/
    )
  })
})

describe("firstTurnDurationSeconds", () => {
  it("uses the configured first turn time", () => {
    expect(firstTurnDurationSeconds(baseSetup({ firstTurnTime: 45 }))).toBe(45)
  })

  it("falls back when no first turn time is set", () => {
    const setup = baseSetup()
    delete setup.firstTurnTime
    expect(firstTurnDurationSeconds(setup)).toBe(60)
  })
})
