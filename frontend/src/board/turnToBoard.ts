import { ClashKind, GameState, Turn, UnitDeath } from "@shared/types/Game"
import { teamColorMap } from "../hooks/useTeamColors"
import { EXHAUSTION_KINDS } from "./clashes"
import { isPieceType, unitTypeFor } from "../utils/unitTypes"
import {
  BoardClash,
  BoardClashKind,
  BoardModel,
  BoardUnit,
  Cell,
  DeathMark,
  DeathStyle,
  DeathVictim,
  RecoveryMark,
  RosterUnit,
  SeverMark,
  UncertaintyMark,
} from "./renderer"

const NEUTRAL_COLOR = "#888888"

// ── What the board is allowed to know ───────────────────────────────────────
//
// Everything drawn about a turn's outcome comes from three fields the server
// writes and nothing else:
//
//   turn.deaths        the authoritative registry: who died, on which cell, on
//                      which sub-step, of what cause. It is the ONLY source of
//                      death marks — the board never concludes "this clash cell
//                      is empty, so somebody must have died on it", which was
//                      wrong on every sever and on every durable cell a later
//                      unit walked onto.
//   turn.severedCells  the cells cut off units that are still alive. Damage.
//   turn.clashes       what was adjudicated, with the victims and the survivor
//                      named IN the record.
//
// Where one of those is missing something, the board draws doubt rather than a
// guess: an unrecognised kind, a record with no victim list, or a unit that
// left the board with no death written for it all end up as an uncertainty
// mark and a note, never as an invented death or an invented attacker.

/** The kinds this board knows how to draw. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<ClashKind>([
  "contest",
  "edge",
  "bodyBlock",
  "sever",
  "hazard",
  "exhaustion",
  "wall",
  "self",
  "regicide",
])

const boardKind = (kind: unknown): BoardClashKind =>
  typeof kind === "string" && KNOWN_KINDS.has(kind)
    ? (kind as BoardClashKind)
    : "unknown"

/**
 * EXHAUSTION_KINDS are the two causes that are not a killing: the unit's energy
 * ran out mid-move and it halted where it stood. Nobody beat it, and the board
 * should not draw as though somebody had.
 *
 * Exhaustion is a PROVISIONAL death. A unit that is still at or below zero when
 * the turn ends is in the death registry and gets the hollow exhaustion mark;
 * one that ate on its halt square recovered, is NOT in the registry, and gets
 * the recovery mark instead. Which of the two happened is never guessed here —
 * the registry decides it.
 */
const deathStyle = (cause: BoardClashKind): DeathStyle => {
  if (cause === "unknown" || cause === "sever") return "unknown"
  return EXHAUSTION_KINDS.has(cause) ? "exhausted" : "combat"
}

/**
 * A full-board index to a renderer cell. The wire numbers squares row-major
 * over the WHOLE board (perimeter wall included) with y growing downward; the
 * renderer's cells grow upward, so the row is flipped and nothing else moves.
 */
export const indexToCell = (
  index: number,
  width: number,
  height: number,
): Cell => ({
  x: index % width,
  y: height - 1 - Math.floor(index / width),
})

const mapIndices = (
  indices: number[] | undefined,
  width: number,
  height: number,
): Cell[] => (indices ?? []).map((i) => indexToCell(i, width, height))

/**
 * The earliest turn on which any of a unit's invulnerability effects lapses —
 * the aggregate level holds only until the first of them expires, so that is
 * the turn the board's countdown measures against. Null when the turn carries
 * no effects schedule at all, which is what tells the renderer it has no
 * countdown to write.
 */
const invulnerabilityExpiryTurn = (
  turn: Turn,
  playerID: string,
): number | undefined => {
  if (!turn.activeEffects) return undefined
  let earliest: number | undefined
  for (const effect of turn.activeEffects) {
    if (effect.playerID !== playerID) continue
    if (earliest === undefined || effect.expiryTurn < earliest) {
      earliest = effect.expiryTurn
    }
  }
  return earliest
}

/**
 * The weight a unit was last seen carrying, at or before the turn being shown:
 * the roster's memory of a unit the board has dropped. Scanning back from the
 * displayed turn (never forward) is what keeps a replay honest — a unit killed
 * on turn 40 shows the weight it died with when turn 41 is on screen, and shows
 * its live weight when turn 39 is.
 */
const lastKnownWeight = (
  gameState: GameState,
  turnIndex: number,
  playerID: string,
): number => {
  for (let i = Math.min(turnIndex, gameState.turns.length - 1); i >= 0; i--) {
    const pieces = gameState.turns[i]?.playerPieces?.[playerID]
    if (pieces && pieces.length > 0) return pieces.length
  }
  return 0
}

/**
 * One Firestore turn document as the board model the renderer draws. Chess
 * pieces arrive as a weight-stack — N copies of ONE square — so they collapse
 * to a single body cell carrying N as their weight; snakes keep their whole
 * body, head first.
 */
export const turnToBoard = (
  gameState: GameState,
  turnIndex: number,
  options?: { showWinningSquares?: boolean },
): BoardModel | null => {
  const turn = gameState.turns[turnIndex]
  if (!turn) return null

  const width = gameState.setup.boardWidth
  const height = gameState.setup.boardHeight
  const teamColors = teamColorMap(gameState.setup.teams)
  // The team's display NAME is the one the game setup snapshotted from the
  // controlling centaur — never the team's document id, which is a key rather
  // than a name.
  const teamNames = new Map(gameState.setup.teams.map((t) => [t.id, t.name]))
  const rosterOf = (playerID: string) =>
    gameState.setup.gamePlayers.find((gp) => gp.id === playerID)
  /**
   * A unit's identity for a mark that is ABOUT that unit: its own letter, its
   * own team, its own colour. A death is drawn in the victim's colour and a
   * sever in the owner's — never in the colour of whoever did it, which is what
   * the old board showed when it took `playerIDs[0]` (usually the attacker) as
   * the colour of the grave.
   */
  const identityOf = (playerID: string) => {
    const roster = rosterOf(playerID)
    const teamID = roster?.teamID
    return {
      letter: roster?.letter ?? "?",
      teamName:
        (teamID !== undefined ? teamNames.get(teamID) : undefined) ??
        teamID ??
        playerID,
      color:
        (teamID !== undefined ? teamColors.get(teamID) : undefined) ??
        NEUTRAL_COLOR,
    }
  }

  // The ROSTER is walked in setup order rather than the turn document's key
  // order, so units (and, downstream, the teams and rows of the scoreboard)
  // come out in one deterministic order: team by team, letters ascending.
  const units: BoardUnit[] = []
  const deadUnits: RosterUnit[] = []
  const aliveNow = new Set<string>()
  gameState.setup.gamePlayers.forEach((gamePlayer) => {
    const playerID = gamePlayer.id
    const positions = turn.playerPieces[playerID]
    const unitType = unitTypeFor(gameState, turn, playerID)
    const identity = {
      id: playerID,
      letter: gamePlayer.letter ?? "?",
      teamID: gamePlayer.teamID,
      teamName: teamNames.get(gamePlayer.teamID) ?? gamePlayer.teamID,
      color: teamColors.get(gamePlayer.teamID) ?? NEUTRAL_COLOR,
      unitType,
    }
    // A unit the board has dropped is dead. It stays in the roster at its
    // last-known state so a scoreboard can keep listing it — struck through,
    // scoring nothing — instead of letting it silently vanish from its team.
    if (!positions || positions.length === 0) {
      deadUnits.push({
        ...identity,
        weight: lastKnownWeight(gameState, turnIndex, playerID),
      })
      return
    }
    aliveNow.add(playerID)
    const isPiece = isPieceType(unitType)
    const body = (isPiece ? positions.slice(0, 1) : positions).map((i) =>
      indexToCell(i, width, height),
    )
    units.push({
      ...identity,
      body,
      // A piece's weight is the height of its stack; a snake's is its length.
      weight: positions.length,
      energy: turn.playerEnergy[playerID] ?? 0,
      maxEnergy: gameState.setup.maxEnergyPerUnit?.[unitType] ?? 100,
      orientation: turn.orientation?.[playerID],
      invulnerabilityLevel: turn.playerInvulnerabilityLevel?.[playerID] ?? 0,
      invulnerabilityExpiryTurn: invulnerabilityExpiryTurn(turn, playerID),
    })
  })

  const recordNotes: string[] = []
  const uncertainties: UncertaintyMark[] = []
  const noteAt = (cell: Cell, note: string) => {
    uncertainties.push({ cell, note })
    if (!recordNotes.includes(note)) recordNotes.push(note)
  }

  // ── Deaths ────────────────────────────────────────────────────────────────
  // Straight off the registry, grouped by the cell each one names. A cell can
  // hold several — two equal heavies annihilating each other on a durable cell,
  // and a lighter unit walking onto the same cell a sub-step later — so the
  // mark keeps every victim, in the order they fell, and the inspector lists
  // them all. A death is recorded whether or not somebody is standing on the
  // cell at the end of the turn: on a head-on contest the winner IS standing
  // there, and that is precisely the death a board must not drop.
  const deathsByCell = new Map<number, DeathVictim[]>()
  const deathRegistry: { [playerID: string]: UnitDeath } = turn.deaths ?? {}
  const hasRegistry = turn.deaths != null
  Object.entries(deathRegistry).forEach(([playerID, death]) => {
    if (!death || typeof death.cell !== "number") {
      recordNotes.push(
        `${identityOf(playerID).teamName} ${identityOf(playerID).letter} is recorded as dead with no cell.`,
      )
      return
    }
    const cause = boardKind(death.cause)
    const identity = identityOf(playerID)
    const victim: DeathVictim = {
      id: playerID,
      letter: identity.letter,
      teamName: identity.teamName,
      color: identity.color,
      cause,
      style: deathStyle(cause),
      subStep: death.subStep ?? 1,
    }
    const list = deathsByCell.get(death.cell)
    if (list) list.push(victim)
    else deathsByCell.set(death.cell, [victim])
    if (cause === "unknown") {
      noteAt(
        indexToCell(death.cell, width, height),
        `A death here was recorded with a cause this board does not know${
          typeof death.cause === "string" ? ` ("${death.cause}")` : ""
        }.`,
      )
    }
  })

  const deaths: DeathMark[] = [...deathsByCell.entries()].map(
    ([index, victims]) => ({
      cell: indexToCell(index, width, height),
      victims: [...victims].sort((a, b) => a.subStep - b.subStep),
    }),
  )

  // ── Units that left with no death written for them ────────────────────────
  // A unit on the board last turn and gone from playerPieces this turn either
  // died — in which case the registry says so — or the record is incomplete.
  // The board marks its LAST-KNOWN cell as uncertain: that is not a claim about
  // what happened, it is a pointer at where the record stops.
  const previous = turnIndex > 0 ? gameState.turns[turnIndex - 1] : undefined
  gameState.setup.gamePlayers.forEach((gamePlayer) => {
    const playerID = gamePlayer.id
    if (aliveNow.has(playerID) || deathRegistry[playerID]) return
    const before = previous?.playerPieces?.[playerID]
    if (!before || before.length === 0) return // Already gone before this turn.
    const identity = identityOf(playerID)
    noteAt(
      indexToCell(before[0], width, height),
      hasRegistry
        ? `${identity.teamName} ${identity.letter} left the board with no death recorded.`
        : `This turn carries no death registry, and ${identity.teamName} ${identity.letter} left the board.`,
    )
  })

  // ── Clash records ─────────────────────────────────────────────────────────
  // Every adjudicated event, mapped into renderer coordinates once, here: the
  // rings on the board and the inspector both read these, so neither has to
  // know how the wire numbers a square. A record missing its kind or its victim
  // list is carried through MARKED INCOMPLETE rather than patched up.
  const clashes: BoardClash[] = (turn.clashes ?? []).map((clash) => {
    const cell = indexToCell(clash.index, width, height)
    const kind = boardKind(clash.kind)
    const victimIDs = Array.isArray(clash.victimIDs) ? clash.victimIDs : []
    const complete = kind !== "unknown" && Array.isArray(clash.victimIDs)
    if (kind === "unknown") {
      noteAt(
        cell,
        `An event here was recorded as "${String(clash.kind)}", which this board does not know how to read.`,
      )
    } else if (!Array.isArray(clash.victimIDs)) {
      noteAt(cell, "An event here was recorded without saying who died.")
    }
    return {
      cell,
      kind,
      playerIDs: Array.isArray(clash.playerIDs) ? clash.playerIDs : [],
      victimIDs,
      survivorID: clash.survivorID,
      subStep: clash.subStep ?? 1,
      reason: clash.reason ?? "",
      complete,
    }
  })

  // ── Sever damage ──────────────────────────────────────────────────────────
  // Cells cut from units that are STILL ALIVE — the one outcome the old board
  // could not show at all, because a cut cell is empty and an empty cell used
  // to be read as a grave.
  const severed: SeverMark[] = []
  Object.entries(turn.severedCells ?? {}).forEach(([ownerID, cells]) => {
    const identity = identityOf(ownerID)
    ;(cells ?? []).forEach((index) => {
      severed.push({
        cell: indexToCell(index, width, height),
        ownerID,
        letter: identity.letter,
        teamName: identity.teamName,
        color: identity.color,
      })
    })
  })

  // ── Near-deaths ───────────────────────────────────────────────────────────
  // An exhaustion record naming NO victim is a unit that ran out of energy,
  // halted short of where it was going, ate what was on its halt square and
  // finished the turn alive. The death registry is what settles it: a unit
  // named there stayed down and gets a grave, and only a unit the registry does
  // NOT name gets the recovery mark. Where the two disagree — a record says
  // nobody died here, the registry says this unit did — the registry wins,
  // because it is the authority, and the disagreement is reported rather than
  // quietly resolved.
  const recoveries: RecoveryMark[] = []
  clashes.forEach((clash) => {
    if (!clash.complete) return
    if (clash.kind !== "exhaustion" && clash.kind !== "hazard") return
    if (clash.victimIDs.length > 0) return
    clash.playerIDs.forEach((playerID) => {
      const identity = identityOf(playerID)
      if (deathRegistry[playerID]) {
        const note = `${identity.teamName} ${identity.letter} is recorded as recovering here and as dying this turn.`
        if (!recordNotes.includes(note)) recordNotes.push(note)
        return
      }
      recoveries.push({
        cell: clash.cell,
        playerID,
        letter: identity.letter,
        teamName: identity.teamName,
        color: identity.color,
        cause: clash.kind,
      })
    })
  })

  const winningSquares = options?.showWinningSquares
    ? mapIndices(
        turn.winners.flatMap((winner) => winner.winningSquares),
        width,
        height,
      )
    : []

  return {
    width,
    height,
    turn: turnIndex,
    // Walls are static for the whole game and live on the game doc, not the turn.
    walls: mapIndices(gameState.walls, width, height),
    hazards: mapIndices(turn.hazards, width, height),
    fertileTiles: mapIndices(turn.fertileTiles, width, height),
    winningSquares,
    food: mapIndices(turn.food, width, height),
    invulnerabilityPotions: mapIndices(
      turn.invulnerabilityPotions,
      width,
      height,
    ),
    teams: gameState.setup.teams.map((team) => ({
      id: team.id,
      name: team.name,
      color: team.color,
    })),
    units,
    deaths,
    clashes,
    severed,
    recoveries,
    uncertainties,
    recordNotes,
    deadUnits,
  }
}
