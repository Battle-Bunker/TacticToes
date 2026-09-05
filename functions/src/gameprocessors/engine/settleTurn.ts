import { ActiveEffect, UnitType } from "@shared/types/Game"
import { BoardView, Outcome, adjudicate } from "./adjudicate"
import { Orientation, toXY } from "./moveGrammar"
import { ResolveTurnInput, TurnResolution, resolveTurn } from "./resolveTurn"
import { Spawner } from "./spawn"

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
 * Settlement also says whether the game is OVER: `outcome` is null while the
 * game continues and an adjudication when it ends. A caller simulating a line
 * therefore knows when the line stops, which is what makes a turn limit
 * representable at all rather than an infinite horizon everybody plays into.
 *
 * The turn's new items come from the injected `Spawner`: the rules for where
 * an item may land and how many arrive are in `spawn.ts` with the rest of the
 * rules, and only the randomness is passed in. The server hands settlement a
 * spawner over its real RNG; a caller that would rather under-model the item
 * supply than invent cells hands it `NO_SPAWN`.
 *
 * Still deliberately absent, because they need state this module does not
 * carry: the winner ROWS, MMR and placements a caller builds out of an
 * outcome; placing hazards, the fertile map and the units themselves when the
 * board is first built; anything Firestore.
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

  /**
   * The weight at which a pawn becomes a queen. Reached, and the pawn's stack
   * collapses to the single square it stands on.
   */
  readonly pawnPromotionWeight: number

  /**
   * The turn count this game is adjudicated at, or null for a game that runs
   * unlimited. Pass `resolveMaxTurns(setup.maxTurns)`: an absent setting is
   * the default limit, and only a written-out null opts out.
   */
  readonly maxTurns: number | null
  /**
   * The previous committed turn's board. Read by exactly one branch — the one
   * where every remaining team dies on this turn and the outcome has to come
   * off the last board somebody was standing on.
   */
  readonly previous?: BoardView
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
  /**
   * Potion cells on the board as the turn closes: the ones no collector took,
   * plus anything the spawner placed. `spawned.potions` names the new ones.
   */
  potions: number[]
  /** The cells the spawner added this turn, already folded into the board. */
  spawned: { food: number[]; potions: number[] }
  /**
   * Facing as the turn closed, survivors only — the dead drop out of the map
   * rather than lingering in it. A caller that keeps its own copy of the
   * previous turn's facings and patches it is writing the rule twice; take
   * this map whole, as the server does.
   */
  orientation: { [unitID: string]: Orientation }
  /**
   * Kind per surviving unit as the turn closed — promotion applied. The only
   * kind change in the game, and the reason a caller cannot treat the kinds it
   * sent in as still current when the next turn opens.
   */
  unitTypes: { [unitID: string]: UnitType }
  /** Units that promoted this turn, for anything that wants to announce it. */
  promoted: string[]
  /**
   * Whether the game ended on this turn, and how. Null while it continues.
   * Adjudicated on the settled board — after promotion, so a pawn that traded
   * its stack for a queen is weighed at the weight it actually ends on.
   */
  outcome: Outcome | null
}

export const settleTurn = (input: SettleInput, spawn: Spawner): Settlement => {
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
  // back. Effects belonging to units that died this turn went with them at the
  // top of this function, where `dead` is the whole death registry.
  //
  // Nothing else is purged here. A second pass that kept only the effects of
  // units on the ROSTER used to run, and it read the same as the death filter
  // for as long as the roster was the whole board — but `settlePartial` hands
  // this function the units whose moves are known, and a held unit is off that
  // roster and very much on the board. The pass erased its entire
  // invulnerability schedule on any turn where anything expired at all, so
  // every window it was carrying stayed open for the rest of the game.
  const expiring = effects.filter((e) => e.expiryTurn <= input.turn)
  if (expiring.length > 0) {
    expiring.forEach((effect) => {
      if (tiers[effect.playerID] !== undefined) tiers[effect.playerID] -= effect.level
    })
    effects = effects.filter((e) => e.expiryTurn > input.turn)
  }

  // 4. Orientation, rewritten from the units still standing — which is why it
  // runs here, after every phase that can kill: the map holds exactly the
  // board, and the dead take their facing off it with them. A unit that moved
  // faces the direction of its FIRST step: sliders and kings the unit step
  // (e.g. {1,0}, {1,1}), knights their exact L-offset (e.g. {1,-2}) since
  // signing one would collapse every jump to a diagonal, trail units head
  // minus the cell the head left — which is why the origin square is read off
  // the unit's start-of-turn occupancy rather than its body, so the rule holds
  // for a snake severed down to its head or one that grew this turn. Pawns are
  // the exception: they change facing ONLY through their rotation action, so a
  // pawn that walked diagonally forward still points the way it pointed.
  // Units that held keep what they had.
  const orientation: { [unitID: string]: Orientation } = {}
  input.units.forEach((u) => {
    if (!alive.has(u.id)) return
    orientation[u.id] = resolution.rotations[u.id] ?? u.orientation
    if (u.type === "pawn") return

    const traversed = resolution.traversed[u.id]
    if (!traversed || traversed.length === 0) return // held
    const from = u.occupancy[0]
    const to = traversed[0]
    if (from === to) return

    const f = toXY(from, input.boardWidth)
    const t = toXY(to, input.boardWidth)
    const dx = t.x - f.x
    const dy = t.y - f.y
    orientation[u.id] =
      u.type === "knight" ? { dx, dy } : { dx: Math.sign(dx), dy: Math.sign(dy) }
  })

  // 5. Promotion, last of all. A pawn that reached the configured weight
  // becomes a queen: after the food phase, so a pawn that ATE its way to the
  // threshold promotes on the very turn it did, and after the orientation
  // rewrite, so it was still a pawn when its facing was decided and kept it.
  // Promotion trades the accumulated mass for the queen's mobility — the
  // stack collapses to the single square the unit occupies, weight 1 and
  // never 0, so nothing is ever eliminated by promoting; only its score
  // drops. A promoted pawn may also be carrying more energy than a queen is
  // allowed, so it is clamped to the queen's max; nothing else in settlement
  // touches energy.
  //
  // A piece's occupancy is N copies of ONE square, never a body, so the
  // collapse frees no cell. That is what lets a caller run its own item
  // spawning after settlement, as the server does, and still see the same
  // free-cell set it would have seen before.
  const unitTypes: { [unitID: string]: UnitType } = {}
  const promoted: string[] = []
  const queenMaxEnergy = input.maxEnergy?.queen ?? input.defaultMaxEnergy ?? 100
  input.units.forEach((u) => {
    if (!alive.has(u.id)) return
    unitTypes[u.id] = u.type
    const settled = resolution.board[u.id]
    if (!settled) return
    if (u.type !== "pawn" || settled.occupancy.length < input.pawnPromotionWeight) return

    unitTypes[u.id] = "queen"
    promoted.push(u.id)
    settled.occupancy = [settled.occupancy[0]]
    if (settled.energy > queenMaxEnergy) settled.energy = queenMaxEnergy
  })

  // 6. Spawning, last of the board phases and after promotion, exactly where
  // the processor used to run it. A promoted pawn's collapse frees no cell —
  // a piece's occupancy is N copies of one square — so the free set is the
  // same either way, but the ORDER is kept anyway: the food spawner draws
  // before the potion spawner, and the potion spawner sees the food that was
  // just placed, so nothing lands on top of anything else.
  const occupancy = aliveInOrder.map(
    (unitID) => resolution.board[unitID]?.occupancy ?? [],
  )
  const spawnState = {
    boardWidth: input.boardWidth,
    boardHeight: input.boardHeight,
    walls: input.walls,
    hazards: input.hazards,
    occupancy,
    food: resolution.food,
    potions,
  }
  const spawnedFood = [...spawn.food(spawnState)]
  const food = [...resolution.food, ...spawnedFood]
  const spawnedPotions = [...spawn.potions({ ...spawnState, food })]
  potions.push(...spawnedPotions)

  // 7. Adjudication, on the board as it now stands: promotion has already
  // collapsed what it was going to collapse, so the weights the outcome is
  // decided at are the weights the turn actually ends with. Spawning food or
  // potions afterwards cannot change it — items are not weight.
  const board: BoardView = {
    alive: aliveInOrder,
    pieces: Object.fromEntries(aliveInOrder.map((unitID, i) => [unitID, occupancy[i]])),
  }
  const adjudicated = adjudicate(
    board,
    input.previous,
    input.teamOf,
    input.turn,
    input.maxTurns,
  )
  const outcome = adjudicated.kind === "continues" ? null : adjudicated

  return {
    ...resolution,
    food,
    effects,
    tiers,
    potions,
    spawned: { food: spawnedFood, potions: spawnedPotions },
    orientation,
    unitTypes,
    promoted,
    outcome,
  }
}
