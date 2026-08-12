import { Team } from "@shared/types/Game"
import { diffInviteCentaurs } from "./centaurGameMeta"

const team = (id: string, color = "#ff0000"): Team => ({
  id,
  name: `Centaur ${id}`,
  color,
})

describe("diffInviteCentaurs", () => {
  it("treats every team as added on setup create (no before)", () => {
    expect(diffInviteCentaurs([], [team("a"), team("b")])).toEqual({
      added: ["a", "b"],
      removed: [],
    })
  })

  it("reports only the added centaur", () => {
    expect(diffInviteCentaurs([team("a")], [team("a"), team("b")])).toEqual({
      added: ["b"],
      removed: [],
    })
  })

  it("reports only the removed centaur", () => {
    expect(diffInviteCentaurs([team("a"), team("b")], [team("b")])).toEqual({
      added: [],
      removed: ["a"],
    })
  })

  it("handles a simultaneous add and remove", () => {
    expect(diffInviteCentaurs([team("a")], [team("b")])).toEqual({
      added: ["b"],
      removed: ["a"],
    })
  })

  it("is empty for unrelated setup edits (same teams, changed colour)", () => {
    expect(
      diffInviteCentaurs([team("a", "#ff0000")], [team("a", "#00ff00")])
    ).toEqual({ added: [], removed: [] })
  })

  it("is empty for identical team lists", () => {
    const teams = [team("a"), team("b")]
    expect(diffInviteCentaurs(teams, teams)).toEqual({ added: [], removed: [] })
  })
})
