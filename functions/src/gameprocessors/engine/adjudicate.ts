/**
 * Adjudication: who has won, on which board, and at what weight.
 *
 * The last rule that was still written outside this directory, and the one
 * with the most implementations: the server decided the game, the harness
 * reproduced the decision to compute placements, and a client predicting a
 * line had to reproduce it again to know whether the line ended at all. Three
 * copies of a four-branch rule, and they disagreed about the branch that is
 * hardest to reach on purpose — the mutual wipe, where nobody is left on the
 * settled board and the outcome comes off the PREVIOUS committed turn.
 *
 * So it lives here now, as one function over two board views. It reads no
 * game state beyond what it is handed: the settled board, the previous
 * committed board, the team map, the turn number and the limit. Nothing here
 * touches Firestore, a clock or an RNG — the same contract as the rest of the
 * module (VENDOR.md).
 *
 * Deliberately NOT here: what a caller DOES with an outcome. Winner rows,
 * MMR, placements and the wire are the caller's business; the rule is only
 * which teams won, on which board, and with what weight behind them.
 */

/** The two facts adjudication reads off a board: who stands, and how heavy. */
export interface BoardView {
  /** Unit ids still standing, in the order the board carries them. */
  readonly alive: ReadonlyArray<string>
  /** Unit id → occupancy. Weight is `occupancy.length`; absent means zero. */
  readonly pieces: { readonly [unitID: string]: ReadonlyArray<number> }
}

export type EndKind = "continues" | "last-team" | "all-eliminated" | "turn-limit"

export interface Outcome {
  readonly kind: EndKind
  /** Winning team ids — several when the deciding weights tied. */
  readonly winners: ReadonlyArray<string>
  /**
   * Weight per team on the board that decided it, every configured team
   * included: a team wiped out weighs 0 rather than going missing.
   */
  readonly weightByTeam: { readonly [teamID: string]: number }
  /**
   * Which board decided it: the settled one, or the previous committed turn's
   * when every remaining team died at once. The distinction three
   * implementations got wrong, so it is reported rather than inferred.
   */
  readonly decidedOn: "settled" | "previous"
}

/**
 * Every game is played to a turn limit; this is the one a setup that names
 * none is played to. The limit is enforced, not optional: only an explicit
 * `maxTurns: null` opts a game out of it (see GameSetup.maxTurns).
 */
export const DEFAULT_MAX_TURNS = 100

/**
 * The limit a setup actually plays to. `null` — and only a written-out `null`
 * — means no limit at all; a setup that says nothing gets the default.
 */
export const resolveMaxTurns = (
  maxTurns: number | null | undefined,
): number | null => (maxTurns === undefined ? DEFAULT_MAX_TURNS : maxTurns)

/**
 * The rule, in the order the branches are tested:
 *
 *  1. nobody standing  → the previous committed board decides (see below);
 *  2. one team standing → it wins, whatever the turn count says;
 *  3. the turn limit reached → the heaviest team wins, tied teams draw;
 *  4. otherwise the game continues.
 *
 * The all-eliminated branch replays 1–3 on the previous board minus the turn
 * limit — a game that ended by wipe did not end on the count — and if there
 * is no previous board, or no configured team at all, nobody won.
 *
 * `teamOf` maps EVERY configured unit to its team, not only the living ones:
 * that is what makes a wiped team weigh 0 instead of vanishing, and it fixes
 * the order tied teams are reported in (the order their first unit appears).
 */
export const adjudicate = (
  board: BoardView,
  previous: BoardView | undefined,
  teamOf: { readonly [unitID: string]: string },
  turn: number,
  maxTurns: number | null,
): Outcome => {
  const settled = decide(board, teamOf, maxTurns !== null && turn >= maxTurns)
  if (settled) return settled

  // Every remaining team went down together. The board that decides is the
  // last one somebody was standing on, and the limit does not apply to it:
  // the game ended by wipe, not by count.
  if (!previous) {
    return { kind: "all-eliminated", winners: [], weightByTeam: {}, decidedOn: "previous" }
  }
  const weightByTeam = weighTeams(previous, teamOf)
  const aliveTeams = teamsStanding(previous, teamOf)
  const winners =
    aliveTeams.length === 1 ? [aliveTeams[0]] : heaviestTeams(weightByTeam)
  return { kind: "all-eliminated", winners, weightByTeam, decidedOn: "previous" }
}

/**
 * The settled board's own verdict, or null when nobody is left on it and the
 * previous board has to answer instead.
 */
const decide = (
  board: BoardView,
  teamOf: { readonly [unitID: string]: string },
  reachedTurnLimit: boolean,
): Outcome | null => {
  const aliveTeams = teamsStanding(board, teamOf)
  if (aliveTeams.length === 0) return null

  const weightByTeam = weighTeams(board, teamOf)
  if (aliveTeams.length === 1) {
    return {
      kind: "last-team",
      winners: [aliveTeams[0]],
      weightByTeam,
      decidedOn: "settled",
    }
  }
  if (reachedTurnLimit) {
    return {
      kind: "turn-limit",
      winners: heaviestTeams(weightByTeam),
      weightByTeam,
      decidedOn: "settled",
    }
  }
  return { kind: "continues", winners: [], weightByTeam, decidedOn: "settled" }
}

/** Teams with at least one unit standing, first appearance first. */
const teamsStanding = (
  board: BoardView,
  teamOf: { readonly [unitID: string]: string },
): string[] => {
  const teams: string[] = []
  board.alive.forEach((unitID) => {
    const teamID = teamOf[unitID]
    if (!teamID || teams.includes(teamID)) return
    teams.push(teamID)
  })
  return teams
}

/** Summed occupancy per configured team; a team with nothing left weighs 0. */
const weighTeams = (
  board: BoardView,
  teamOf: { readonly [unitID: string]: string },
): { [teamID: string]: number } => {
  const weight: { [teamID: string]: number } = {}
  Object.keys(teamOf).forEach((unitID) => {
    const teamID = teamOf[unitID]
    if (!teamID) return
    weight[teamID] = (weight[teamID] ?? 0) + (board.pieces[unitID]?.length ?? 0)
  })
  return weight
}

/** The teams at the maximum weight — one winner, or a draw between several. */
const heaviestTeams = (weightByTeam: {
  readonly [teamID: string]: number
}): string[] => {
  const teams = Object.keys(weightByTeam)
  if (teams.length === 0) return []
  const max = Math.max(...teams.map((teamID) => weightByTeam[teamID]))
  return teams.filter((teamID) => weightByTeam[teamID] === max)
}

/**
 * The outcome as a score per team: its share of the end weight, times the
 * number of teams. Par is 1 — a team that finishes with exactly its share of
 * the board scores 1, the winner of a two-team game scores between 1 and 2,
 * and a team wiped out scores 0. Continuous in the margin, so a game won by a
 * nose and a game won by the whole board are not the same result.
 *
 * A board with no weight left on it at all (everything died) is a dead heat:
 * every team scores par.
 */
export const sharePar = (
  outcome: Outcome,
  teams: number,
): { [teamID: string]: number } => {
  const ids = Object.keys(outcome.weightByTeam)
  const total = ids.reduce((sum, id) => sum + outcome.weightByTeam[id], 0)
  const score: { [teamID: string]: number } = {}
  ids.forEach((id) => {
    score[id] = total > 0 ? (outcome.weightByTeam[id] / total) * teams : 1
  })
  return score
}
