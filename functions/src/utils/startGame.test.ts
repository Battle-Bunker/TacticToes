import { GamePlayer, GameSetup } from "@shared/types/Game"
import { Timestamp } from "firebase-admin/firestore"
import { firstTurnDurationSeconds, reasonNotToStart } from "./startGame"
import { withResolvedIdentities } from "./playerIdentity"

const baseSetup = (overrides: Partial<GameSetup> = {}): GameSetup => ({
  gameType: "snek",
  gamePlayers: [
    { id: "human1", type: "human" },
    { id: "bot1", type: "bot" },
  ],
  boardWidth: 11,
  boardHeight: 11,
  playersReady: ["human1"],
  maxTurnTime: 10,
  firstTurnTime: 30,
  startRequested: true,
  started: false,
  timeCreated: Timestamp.fromMillis(0),
  ...overrides,
})

describe("reasonNotToStart (playersReady)", () => {
  const trigger = { kind: "playersReady" } as const

  it("allows a ready, start-requested game", () => {
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

  it("refuses when a human is not ready", () => {
    expect(reasonNotToStart(baseSetup({ playersReady: [] }), trigger)).toMatch(/not all/)
  })

  it("ignores bot readiness", () => {
    const setup = baseSetup({
      gamePlayers: [{ id: "bot1", type: "bot" }],
      playersReady: [],
    })
    expect(reasonNotToStart(setup, trigger)).toBeNull()
  })

  it("refuses an empty game", () => {
    expect(reasonNotToStart(baseSetup({ gamePlayers: [] }), trigger)).toMatch(/no players/)
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
      playersReady: [],
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

  it("falls back for setups predating firstTurnTime", () => {
    const setup = baseSetup()
    delete setup.firstTurnTime
    expect(firstTurnDurationSeconds(setup)).toBe(60)
  })
})

describe("withResolvedIdentities", () => {
  const directory = {
    bots: new Map([
      ["bot1", { id: "bot1", name: "Chris Centaur Dev", emoji: "🐍" } as any],
    ]),
    humans: new Map([["human1", { id: "human1", name: "Chris", emoji: "🙂" } as any]]),
  }

  it("names the original bot instance instead of leaving its ID exposed", () => {
    const players: GamePlayer[] = [{ id: "bot1", type: "bot" }]
    expect(withResolvedIdentities(players, directory)[0]).toEqual({
      id: "bot1",
      type: "bot",
      displayName: "Chris Centaur Dev",
      displayEmoji: "🐍",
    })
  })

  it("keeps a clone's per-game overrides", () => {
    const players: GamePlayer[] = [
      {
        id: "bot1#ab12",
        type: "bot",
        botRef: "bot1",
        displayName: "Chris Centaur Dev 2",
        displayEmoji: "🐲",
      },
    ]
    const [clone] = withResolvedIdentities(players, directory)
    expect(clone.displayName).toBe("Chris Centaur Dev 2")
    expect(clone.displayEmoji).toBe("🐲")
  })

  it("names humans too", () => {
    const players: GamePlayer[] = [{ id: "human1", type: "human" }]
    expect(withResolvedIdentities(players, directory)[0].displayName).toBe("Chris")
  })

  it("leaves players with no record untouched", () => {
    const players: GamePlayer[] = [{ id: "ghost", type: "bot" }]
    expect(withResolvedIdentities(players, directory)[0]).toEqual({
      id: "ghost",
      type: "bot",
    })
  })
})
