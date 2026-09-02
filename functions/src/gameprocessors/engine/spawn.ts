/**
 * Item spawning: where a food or a potion may land, how many arrive, and who
 * decides which free cell each one takes.
 *
 * Spawning is the only nondeterminism a turn has, and for as long as it lived
 * in the processor that was the argument for keeping it out of this directory
 * — nothing in here may read a clock or an RNG (VENDOR.md). But "it is
 * random" was never the whole of it. WHICH cells an item may land on is a
 * rule: not a wall, not a hazard, not under a unit, not on top of another
 * item, and on fertile ground only when the setup says so. How MANY arrive is
 * a rule too: the whole part of the rate always, plus one more with the
 * probability of the fraction. All of that is board arithmetic a client
 * predicting a turn has to reproduce, and reproducing it is how a second
 * encoding of the rules gets written.
 *
 * So the rules move here and the randomness becomes an input: `Rng` is the
 * one thing injected, and the server hands it the real one. A caller that
 * wants a barer board — a search that would rather under-model the item
 * supply than invent cells — passes `NO_SPAWN` instead and spawns nothing.
 *
 * NOT here: hazards and the fertile map. Neither is a turn-advance spawner —
 * they are placed once, when the board is built, out of the same pass that
 * chooses where the units start, and they never move again. That pass is
 * placement, and placement stays with the caller.
 */

/** The only nondeterminism in the game, injected: a uniform draw in [0, 1). */
export interface Rng {
  next(): number
}

/** The board as it stands when the spawners run: after everything has settled. */
export interface SpawnState {
  readonly boardWidth: number
  readonly boardHeight: number
  readonly walls: ReadonlyArray<number>
  readonly hazards: ReadonlyArray<number>
  /** Occupancy of every unit still standing, one entry per unit. */
  readonly occupancy: ReadonlyArray<ReadonlyArray<number>>
  readonly food: ReadonlyArray<number>
  readonly potions: ReadonlyArray<number>
}

/**
 * Where the turn's new items come from. Each call returns the cells it ADDS,
 * never the board's whole contents, and `potions` sees the food that `food`
 * has just placed — two items never share a cell.
 */
export interface Spawner {
  food(state: SpawnState): ReadonlyArray<number>
  potions(state: SpawnState): ReadonlyArray<number>
}

/** Settle the turn and put nothing new on the board. */
export const NO_SPAWN: Spawner = {
  food: () => [],
  potions: () => [],
}

/** The rate a setup that names none plays at. */
export const DEFAULT_FOOD_SPAWN_RATE = 0.5
/** Potions are rarer, and always on when potions are enabled at all. */
export const DEFAULT_POTION_SPAWN_RATE = 0.15

/**
 * Food per turn. A setup may write the rate either as a fraction (0.5) or as
 * a percentage (50), and anything above 5 is read as the latter — nobody
 * means five foods a turn.
 */
export const resolveFoodSpawnRate = (rate: number | undefined): number => {
  const raw = rate ?? DEFAULT_FOOD_SPAWN_RATE
  return raw > 5 ? raw / 100 : raw
}

/** Potions per turn. Written as a fraction only, so nothing is reinterpreted. */
export const resolvePotionSpawnRate = (rate: number | undefined): number =>
  rate ?? DEFAULT_POTION_SPAWN_RATE

export interface SpawnRules {
  /** Foods per turn: the whole part always, the fraction as a probability. */
  readonly foodSpawnRate: number
  /** Off, and potions are inert scenery: nothing spawns and nothing collects. */
  readonly potionsEnabled: boolean
  /** Potions per turn, read the same way as the food rate. */
  readonly potionSpawnRate: number
  /**
   * The cells food may land on. Empty means the whole board — a setup with
   * fertile ground switched off, or one whose fertile map came out empty,
   * grows food anywhere.
   */
  readonly fertileTiles?: ReadonlyArray<number>
}

/**
 * The game's real spawner: the rules above, with one injected source of
 * randomness. It draws in a fixed order — the fractional coin first, then one
 * draw per item placed, and no draw at all when there is nowhere to put one —
 * because a caller replaying a game against a seeded generator is entitled to
 * the same sequence landing in the same cells.
 */
export const randomSpawner = (rules: SpawnRules, rng: Rng): Spawner => ({
  food: (state) => {
    const fertile =
      rules.fertileTiles && rules.fertileTiles.length > 0
        ? new Set(rules.fertileTiles)
        : undefined
    return place(state, rules.foodSpawnRate, rng, fertile)
  },
  potions: (state) =>
    rules.potionsEnabled ? place(state, rules.potionSpawnRate, rng) : [],
})

/**
 * How many items a rate produces this turn, and where each one goes. The free
 * set is recomputed between items, so two items spawned on the same turn never
 * land on the same cell.
 */
const place = (
  state: SpawnState,
  rate: number,
  rng: Rng,
  fertile?: Set<number>,
): number[] => {
  const guaranteed = Math.floor(rate)
  const total = guaranteed + (rng.next() < rate - guaranteed ? 1 : 0)

  const placed: number[] = []
  for (let i = 0; i < total; i++) {
    let free = freeCells({ ...state, food: [...state.food, ...placed] })
    if (fertile) free = free.filter((cell) => fertile.has(cell))
    if (free.length === 0) continue
    placed.push(free[Math.floor(rng.next() * free.length)])
  }
  return placed
}

/**
 * Every cell an item may legally land on, in board order: not a wall, not a
 * hazard, not under a unit, and not already holding an item. The rule a
 * caller would otherwise have to write for itself to know what the spawner
 * could possibly do.
 */
export const freeCells = (state: SpawnState): number[] => {
  const occupied = new Set<number>()
  state.occupancy.forEach((cells) => cells.forEach((cell) => occupied.add(cell)))
  state.food.forEach((cell) => occupied.add(cell))
  state.potions.forEach((cell) => occupied.add(cell))
  state.hazards.forEach((cell) => occupied.add(cell))
  state.walls.forEach((cell) => occupied.add(cell))

  const free: number[] = []
  const cells = state.boardWidth * state.boardHeight
  for (let cell = 0; cell < cells; cell++) {
    if (!occupied.has(cell)) free.push(cell)
  }
  return free
}
