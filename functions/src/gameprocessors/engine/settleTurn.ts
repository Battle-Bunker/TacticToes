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
 * board, the roster, the turn number, the effect schedule and the potions on
 * the board, and hands back the settled board plus the schedule, the potions
 * and the per-unit tiers as they stand once the turn has closed.
 *
 * `tier` is therefore now an INPUT AND AN OUTPUT of this module: a caller
 * hands settlement the tiers a turn is adjudicated at and reads back the ones
 * the next turn starts from. A caller that keeps its own tier arithmetic —
 * charging a pickup, lapsing a window — has written the second encoding again.
 * Read `tiers`.
 *
 * Still deliberately absent, because they need state this module does not
 * carry: SPAWNING food, hazards and potions (all random — collection is a
 * rule, spawning is a die roll); the orientation rewrite; pawn promotion;
 * scoring, winners and MMR; anything Firestore.
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

  /** Potion cells on the board as the turn opened. */
  readonly potions: ReadonlyArray<number>
  /** Off, and potions are inert scenery: nothing spawns and nothing collects. */
  readonly potionsEnabled: boolean
  /**
   * How many turns a collected potion's debuff and its allies' buffs last.
   * Hardcoded as `+3` for as long as it lived in the processor, which is what
   * made the 3/8/20 sweep an engine patch a vendoring client could not mirror.
   * It is a number now, so the sweep is a config change on both sides.
   */
  readonly potionWindowTurns: number
}

/** The window a setup that names none plays with. */
export const DEFAULT_POTION_WINDOW_TURNS = 3

export interface Settlement extends TurnResolution {
  /** The schedule as the turn closed: cancelled buffs and lapsed effects gone. */
  effects: ActiveEffect[]
  /**
   * Per-unit tier as the NEXT turn starts, survivors only — the input tiers
   * with this turn's pickups charged and every lapsed effect's level given
   * back. The unlock: a caller simulating a turn can now advance a tier window
   * instead of freezing it, so "arm, collect, spend" is a state sequence a
   * search can walk rather than three turns that all look the same.
   */
  tiers: { [unitID: string]: number }
  /** Potion cells still on the board once every collector has taken one. */
  potions: number[]
}

export const settleTurn = (input: SettleInput): Settlement => {
  const resolution = resolveTurn(input)

  const dead = new Set(Object.keys(resolution.deaths))
  const aliveInOrder = input.units.filter((u) => !dead.has(u.id)).map((u) => u.id)
  const alive = new Set(aliveInOrder)

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

  // 2. Potion collection. A unit whose head finished the turn on a potion
  // takes it, and the pickup rule is inverted: the COLLECTOR takes -1 and each
  // of its living allies takes +1, all of it lapsing one window from now. Two
  // units cannot share a cell, so no potion is ever taken twice.
  const potions = [...input.potions]
  if (input.potionsEnabled) {
    const taken = new Set<number>()
    const collectors: { unitID: string; potionIndex: number }[] = []
    aliveInOrder.forEach((unitID) => {
      const settled = resolution.board[unitID]
      if (!settled) return
      const potionIndex = potions.indexOf(settled.occupancy[0])
      if (potionIndex !== -1) collectors.push({ unitID, potionIndex })
    })

    const expiryTurn = input.turn + input.potionWindowTurns
    collectors.forEach(({ unitID, potionIndex }) => {
      taken.add(potionIndex)
      tiers[unitID] = (tiers[unitID] ?? 0) - 1
      effects.push({
        playerID: unitID,
        type: "invulnerability_debuff",
        level: -1,
        expiryTurn,
        sourcePlayerID: unitID,
      })

      const teamID = input.teamOf[unitID]
      if (!teamID) return
      aliveInOrder.forEach((allyID) => {
        if (allyID === unitID) return
        if (input.teamOf[allyID] !== teamID) return
        tiers[allyID] = (tiers[allyID] ?? 0) + 1
        effects.push({
          playerID: allyID,
          type: "invulnerability_buff",
          level: 1,
          expiryTurn,
          sourcePlayerID: unitID,
        })
      })
    })

    for (let i = potions.length - 1; i >= 0; i--) {
      if (taken.has(i)) potions.splice(i, 1)
    }
  }

  // 3. Expiry, at the END of the turn: an effect due at turn E still decided
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

  return { ...resolution, effects, tiers, potions }
}
