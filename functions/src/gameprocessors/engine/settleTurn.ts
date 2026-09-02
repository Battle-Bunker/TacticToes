import { ActiveEffect } from "@shared/types/Game"
import { ResolveTurnInput, TurnResolution, resolveTurn } from "./resolveTurn"

/**
 * Turn SETTLEMENT: everything `resolveTurn` does, and then the end-of-turn
 * bookkeeping that used to sit above it in the server's processor.
 *
 * `resolveTurn` answers "where is everything, and what died" and stops there,
 * because the phases that follow read game-level state — the invulnerability
 * effect schedule, the turn number, the team map. That was never true of the
 * RULES, only of where the state happened to be kept: none of those phases
 * touches a clock, a random number or a database, and every one of them is
 * something a client predicting a turn has to reproduce. Reproducing them is
 * how a second encoding of the rules gets written, which is the one thing
 * VENDOR.md exists to prevent.
 *
 * So they move here, and the caller passes the state in. Settlement takes the
 * board, the roster, the turn number and the effect schedule, and hands back
 * the settled board plus the effect schedule and the per-unit tiers as they
 * stand once the turn has closed.
 *
 * `tier` is therefore now an INPUT AND AN OUTPUT of this module: a caller
 * hands settlement the tiers a turn is adjudicated at and reads back the ones
 * the next turn starts from. A caller that keeps its own tier arithmetic has
 * written the second encoding again — read `tiers` instead.
 *
 * Still deliberately absent, because they need state this module does not
 * carry: spawning food, hazards and potions (all random); the orientation
 * rewrite; pawn promotion; scoring, winners and MMR; anything Firestore.
 */

export interface SettleInput extends ResolveTurnInput {
  /** The turn being resolved. Effect expiry and window arithmetic read it. */
  readonly turn: number
  /**
   * Unit id → team id, for EVERY configured unit, not only the living ones:
   * the ally-buff cancel reaches a teammate's effects whether or not that
   * teammate is still on the board.
   */
  readonly teamOf: { readonly [unitID: string]: string }
  /** The invulnerability effect schedule as the turn opened. Never mutated. */
  readonly effects: ReadonlyArray<ActiveEffect>
}

export interface Settlement extends TurnResolution {
  /** The schedule as the turn closed: cancelled buffs and lapsed effects gone. */
  effects: ActiveEffect[]
  /**
   * Per-unit tier as the NEXT turn starts, survivors only — the input tiers
   * with every lapsed effect's level given back. The unlock: a caller
   * simulating a turn can now advance a tier window instead of freezing it.
   */
  tiers: { [unitID: string]: number }
}

export const settleTurn = (input: SettleInput): Settlement => {
  const resolution = resolveTurn(input)

  const dead = new Set(Object.keys(resolution.deaths))
  const alive = new Set(input.units.filter((u) => !dead.has(u.id)).map((u) => u.id))

  // Survivors carry their tier into the next turn; the dead take theirs, and
  // their effects, off the board with them.
  const tiers: { [unitID: string]: number } = {}
  input.units.forEach((u) => {
    if (alive.has(u.id)) tiers[u.id] = u.tier
  })
  let effects = input.effects
    .filter((e) => !dead.has(e.playerID))
    .map((e) => ({ ...e }))

  // 1. Ally-buff cancel. A unit that was vulnerable when it collided — killed,
  // or severed and still standing — takes its team's borrowed invulnerability
  // down with it: every ALLY buff on that team is rescheduled to lapse at the
  // end of this very turn, which the expiry phase below then carries out.
  resolution.vulnerableCollided.forEach((unitID) => {
    const teamID = input.teamOf[unitID]
    if (!teamID) return
    effects.forEach((effect) => {
      if (effect.type !== "invulnerability_buff") return
      if (effect.playerID === unitID) return
      if (input.teamOf[effect.playerID] !== teamID) return
      effect.expiryTurn = input.turn
    })
  })

  // 2. Expiry, at the END of the turn: an effect due at turn E still decided
  // every collision resolved during turn E, and only then gives its level
  // back. Effects belonging to units that are no longer standing go with them
  // — but, as it always has, only on a turn where something expired at all.
  const expiring = effects.filter((e) => e.expiryTurn <= input.turn)
  if (expiring.length > 0) {
    expiring.forEach((effect) => {
      if (tiers[effect.playerID] !== undefined) tiers[effect.playerID] -= effect.level
    })
    effects = effects.filter((e) => e.expiryTurn > input.turn)
    effects = effects.filter((e) => alive.has(e.playerID))
  }

  return { ...resolution, effects, tiers }
}
