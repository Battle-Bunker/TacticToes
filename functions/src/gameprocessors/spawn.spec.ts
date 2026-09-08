// The spawner's rules, and its draws.
//
// Spawning used to be the reason a client could not simulate a whole turn:
// the free-cell set, the rate arithmetic and the fertile filter all lived in
// the processor, and a client that wanted them had to write them again. They
// are the module's now, with the randomness injected — so these tests pin
// both halves, the rule and the DRAW ORDER the rule consumes, because a
// replay against a seeded generator is only reproducible if the second half
// holds too.

import {
  NO_SPAWN,
  SpawnState,
  freeCells,
  randomSpawner,
  resolveFoodSpawnRate,
  resolvePotionSpawnRate,
} from "./engine/spawn"

// 5x5 board: index = y * 5 + x, perimeter wall, interior 6,7,8,11,12,13,16,17,18.
const W = 5
const at = (x: number, y: number): number => y * W + x
const PERIMETER = [0, 1, 2, 3, 4, 5, 9, 10, 14, 15, 19, 20, 21, 22, 23, 24]

const state = (overrides: Partial<SpawnState> = {}): SpawnState => ({
  boardWidth: W,
  boardHeight: W,
  walls: PERIMETER,
  hazards: [],
  occupancy: [],
  food: [],
  potions: [],
  ...overrides,
})

/** A generator that hands out a scripted sequence and counts what was taken. */
const scripted = (draws: number[]) => {
  let taken = 0
  return {
    rng: { next: () => draws[taken++] ?? 0 },
    get taken() {
      return taken
    },
  }
}

describe("freeCells", () => {
  it("is every interior cell of an empty board, in board order", () => {
    expect(freeCells(state())).toEqual([6, 7, 8, 11, 12, 13, 16, 17, 18])
  })

  it("excludes units, items and hazards as well as walls", () => {
    const free = freeCells(
      state({
        occupancy: [[at(1, 1), at(1, 2)], [at(3, 3)]],
        food: [at(2, 1)],
        potions: [at(3, 1)],
        hazards: [at(1, 3)],
      }),
    )
    expect(free).toEqual([at(2, 2), at(3, 2), at(2, 3)])
  })

  it("counts a stacked piece's repeated square once", () => {
    const stacked = at(2, 2)
    expect(freeCells(state({ occupancy: [[stacked, stacked, stacked]] }))).not.toContain(
      stacked,
    )
  })
})

describe("randomSpawner", () => {
  const rules = {
    foodSpawnRate: 0,
    potionsEnabled: true,
    potionSpawnRate: 0,
  }

  it("spends one draw on the fractional coin even when the rate is zero", () => {
    // The rate arithmetic is unconditional: a rate of 0 still asks, and still
    // loses. Skipping the ask would shift every later draw in a replay.
    const script = scripted([0.9])
    expect(randomSpawner(rules, script.rng).food(state())).toEqual([])
    expect(script.taken).toBe(1)
  })

  it("takes the coin, then one draw per item, and places on the free set", () => {
    // 1.5 foods: one guaranteed, one on a coin that comes up under 0.5. Two
    // draws follow, each an index into the free cells as they stand.
    const script = scripted([0.25, 0, 0.99])
    const spawner = randomSpawner({ ...rules, foodSpawnRate: 1.5 }, script.rng)

    expect(spawner.food(state())).toEqual([6, 18])
    expect(script.taken).toBe(3)
  })

  it("never puts two of a turn's items on the same cell", () => {
    // Both index draws point at the head of the free set; the second sees a
    // set the first has already taken a cell out of.
    const script = scripted([0.25, 0, 0])
    const spawner = randomSpawner({ ...rules, foodSpawnRate: 1.5 }, script.rng)

    expect(spawner.food(state())).toEqual([6, 7])
  })

  it("draws no index at all when there is nowhere to put an item", () => {
    const script = scripted([0])
    const full = state({ occupancy: [freeCells(state())] })
    const spawner = randomSpawner({ ...rules, foodSpawnRate: 1 }, script.rng)

    expect(spawner.food(full)).toEqual([])
    expect(script.taken).toBe(1) // the coin, and nothing else
  })

  it("keeps food on fertile ground when the setup names any", () => {
    const script = scripted([0, 0.99])
    const fertile = [at(2, 2), at(3, 3)]
    const spawner = randomSpawner(
      { ...rules, foodSpawnRate: 1, fertileTiles: fertile },
      script.rng,
    )

    expect(spawner.food(state())).toEqual([at(3, 3)])
  })

  it("grows food anywhere when the fertile map is empty", () => {
    const script = scripted([0, 0])
    const spawner = randomSpawner(
      { ...rules, foodSpawnRate: 1, fertileTiles: [] },
      script.rng,
    )

    expect(spawner.food(state())).toEqual([6])
  })

  it("spends no draw on potions at all when potions are switched off", () => {
    // Inert scenery: nothing spawns, and — this is the part a replay feels —
    // the die is not touched, so the next thing to draw gets the same number
    // it would have got with potions never configured.
    const script = scripted([0, 0])
    const spawner = randomSpawner(
      { ...rules, potionsEnabled: false, potionSpawnRate: 1 },
      script.rng,
    )

    expect(spawner.potions(state())).toEqual([])
    expect(script.taken).toBe(0)
  })

  it("spawns potions on the free set when they are on", () => {
    const script = scripted([0, 0.99])
    const spawner = randomSpawner({ ...rules, potionSpawnRate: 1 }, script.rng)

    expect(spawner.potions(state())).toEqual([18])
  })
})

describe("NO_SPAWN", () => {
  it("puts nothing on the board, of either kind", () => {
    expect(NO_SPAWN.food(state())).toEqual([])
    expect(NO_SPAWN.potions(state())).toEqual([])
  })
})

describe("spawn rates", () => {
  it("defaults food to a half and potions to 0.15", () => {
    expect(resolveFoodSpawnRate(undefined)).toBe(0.5)
    expect(resolvePotionSpawnRate(undefined)).toBe(0.15)
  })

  it("reads a food rate above 5 as the percentage somebody meant", () => {
    expect(resolveFoodSpawnRate(50)).toBe(0.5)
    expect(resolveFoodSpawnRate(5)).toBe(5)
    expect(resolveFoodSpawnRate(0)).toBe(0)
  })

  it("leaves a potion rate exactly as written", () => {
    expect(resolvePotionSpawnRate(50)).toBe(50)
    expect(resolvePotionSpawnRate(0)).toBe(0)
  })
})
