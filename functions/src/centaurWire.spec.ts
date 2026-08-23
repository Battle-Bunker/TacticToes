// The server-side contract a centaur client stages against.
//
// A client that revises its move during a turn — and a team client that submits
// several players in one writeBatch — depends on a handful of behaviours that
// live in two places: firestore.rules (what a write is allowed to be) and the
// TypeScript triggers (when a turn resolves). Both are pinned here so that
// changing either fails a test rather than a game.
//
// The rules half is pinned as TEXT. Evaluating real rules needs the Firestore
// emulator, which this suite does not run; the clauses below are short, exact
// and security-critical, so they are asserted verbatim after comments and
// whitespace are normalised away. A deliberate rules edit updates the expected
// string here in the same commit, and an accidental one fails loudly.
//
// The selection half — which staged write actually becomes the move — is
// executable and lives in gameprocessors/processTurn.test.ts.

import { readFileSync } from "fs"
import { join } from "path"
import { MoveStatus } from "@shared/types/Game"
import { onMoveCreated } from "./onMoveCreated"
import { resolveTurnAndAnnounce } from "./utils/resolveTurnAndAnnounce"

jest.mock("./utils/resolveTurnAndAnnounce")

const RULES = readFileSync(
  join(__dirname, "..", "..", "firestore.rules"),
  "utf8"
)
  // Rules carry no string literals containing "//", so line comments strip
  // cleanly — and their prose (and its braces) would otherwise confuse both
  // the block scanner and the comparisons.
  .replace(/\/\/[^\n]*/g, "")

const norm = (source: string): string => source.replace(/\s+/g, " ").trim()

/**
 * The body of the block introduced by `header`, braces balanced. The header is
 * matched literally, so a `match` path's own `{wildcard}` braces are skipped.
 */
const blockBody = (header: string): string => {
  const start = RULES.indexOf(header)
  if (start < 0) throw new Error(`firestore.rules has no "${header}"`)
  const open = RULES.indexOf("{", start + header.length)
  let depth = 0
  for (let i = open; i < RULES.length; i++) {
    if (RULES[i] === "{") depth++
    else if (RULES[i] === "}" && --depth === 0) {
      return norm(RULES.slice(open + 1, i))
    }
  }
  throw new Error(`unbalanced braces after "${header}"`)
}

/** Every operation a match block permits, e.g. ["read", "create"]. */
const allowedOps = (body: string): string[] =>
  Array.from(body.matchAll(/allow ([a-z, ]+):/g)).flatMap((m) =>
    m[1].split(",").map((op) => op.trim())
  )

describe("firestore.rules: staging a move", () => {
  const privateMoves = () => blockBody("match /privateMoves/{moveId}")

  it("is append-only: a revision is a new document, never an edit or a delete", () => {
    // The whole reduction in processTurn rests on this. A client cannot
    // overwrite or withdraw what it staged; it stages again, and the newest
    // write at or before endTime wins.
    expect(allowedOps(privateMoves())).toEqual(["read", "create"])
  })

  it("admits a create from the centaur that owns the player, until that player commits", () => {
    expect(privateMoves()).toBe(
      "allow read: if isCentaur() && " +
        "centaurControlsPlayer(sessionId, gameId, resource.data.playerID); " +
        "allow create: if isCentaur() && " +
        "isValidPrivateMove(request.resource.data) && " +
        "centaurControlsPlayer(sessionId, gameId, request.resource.data.playerID) && " +
        "!hasCommittedForTurn(sessionId, gameId, request.resource.data.moveNumber, request.resource.data.playerID);"
    )
  })

  it("freezes a player's staged move the moment it appears in movedPlayerIDs", () => {
    // The commit gate. Membership is read from the turn's own moveStatuses
    // document, so committing player A never blocks staging for player B —
    // including two players written in the same batch.
    expect(blockBody("function hasCommittedForTurn(sessionId, gameId, moveNumber, playerID)")).toBe(
      "return playerID in get(/databases/$(database)/documents/sessions/" +
        "$(sessionId)/games/$(gameId)/moveStatuses/$(string(moveNumber))" +
        ").data.movedPlayerIDs;"
    )
  })

  it("validates each staged document on its own, with no reference to the live turn", () => {
    // Every document in a batch is validated independently — nothing here
    // reads another document in the same write, so N creates for N different
    // players pass exactly as N separate creates would.
    const body = blockBody("function isValidPrivateMove(move)")
    expect(body).toBe(
      "return move.keys().hasAll(['gameID', 'moveNumber', 'playerID', 'move', 'timestamp']) && " +
        "move.gameID is string && " +
        "move.moveNumber is int && move.moveNumber >= 0 && " +
        "move.playerID is string && " +
        "move.move is int && move.move >= 0 && " +
        "(move.timestamp is timestamp || move.timestamp == request.time);"
    )
    // hasAll, not hasOnly: unknown fields are accepted by the rules and
    // ignored by resolution, which reads only the five above.
    expect(body).not.toContain("hasOnly")
    // Legality is the engine's business, not the rules': any in-range integer
    // is a well-formed stage, and an illegal destination becomes the unit's
    // default action at resolution.
    expect(body).not.toContain("boardWidth")
  })
})

describe("firestore.rules: committing a move", () => {
  const moveStatuses = () => blockBody("match /moveStatuses/{moveStatusId}")

  it("lets a centaur only update the document, never create or delete it", () => {
    // The document is created server-side with the turn (processTurn /
    // startGame), so a client that races ahead of the new turn has nothing to
    // update yet.
    expect(allowedOps(moveStatuses())).toEqual(["read", "update"])
    expect(moveStatuses()).toBe(
      "allow read: if true; " +
        "allow update: if isCentaur() && " +
        "isValidMoveStatusUpdate(resource.data, request.resource.data, sessionId, gameId);"
    )
  })

  it("accepts exactly one newly-added player per write, and freezes the rest of the document", () => {
    // One update per player: a team of N commits with N sequential writes, not
    // one write listing N ids. Re-adding an id that is already there adds
    // zero and is refused, so a commit retry after a successful commit fails.
    expect(blockBody("function isValidMoveStatusUpdate(current, next, sessionId, gameId)")).toBe(
      "let addedIds = next.movedPlayerIDs.removeAll(current.movedPlayerIDs); " +
        "return current.moveNumber == next.moveNumber && " +
        "current.alivePlayerIDs == next.alivePlayerIDs && " +
        "addedIds.size() == 1 && " +
        "centaurControlsPlayer(sessionId, gameId, addedIds[0]);"
    )
  })
})

describe("onMoveCreated: when a turn stops accepting moves", () => {
  const mockedResolve = resolveTurnAndAnnounce as jest.MockedFunction<
    typeof resolveTurnAndAnnounce
  >

  /** Fires the trigger with the moveStatuses document as it now stands. */
  const fire = (status: MoveStatus, moveNumber = 3): Promise<unknown> => {
    const change = { after: { data: () => status } }
    const context = {
      params: { sessionID: "s1", gameID: "g1", moveNumber: `${moveNumber}` },
    }
    return (
      onMoveCreated as unknown as {
        run: (c: unknown, ctx: unknown) => Promise<unknown>
      }
    ).run(change, context)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockedResolve.mockResolvedValue(undefined)
  })

  it("waits while any alive player is still uncommitted", async () => {
    await fire({
      moveNumber: 3,
      alivePlayerIDs: ["t1", "t2", "t3"],
      movedPlayerIDs: ["t1", "t2"],
    })

    expect(mockedResolve).not.toHaveBeenCalled()
  })

  it("resolves the turn as soon as the last alive player commits — before endTime", async () => {
    // The deadline is a ceiling, not a schedule: a client that means to keep
    // revising until endTime must not commit, and can still be cut short by
    // everyone else committing.
    await fire({
      moveNumber: 3,
      alivePlayerIDs: ["t1", "t2"],
      movedPlayerIDs: ["t2", "t1"],
    })

    expect(mockedResolve).toHaveBeenCalledTimes(1)
    expect(mockedResolve).toHaveBeenCalledWith("s1", "g1", 3, "onMoveCreated")
  })

  it("ignores committed players who are no longer alive", async () => {
    // Commitment is checked alive-side: a dead player's stale id neither
    // blocks nor triggers resolution.
    await fire({
      moveNumber: 3,
      alivePlayerIDs: ["t1"],
      movedPlayerIDs: ["t1", "ghost"],
    })

    expect(mockedResolve).toHaveBeenCalledTimes(1)
  })
})
