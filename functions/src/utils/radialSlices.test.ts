import {
  SLICE_SAMPLES_PER_AXIS,
  assignCellsToSlices,
  sliceDistance,
  sliceIndexForAngle,
  sliceOverlapCounts,
} from "./radialSlices"

const TAU = Math.PI * 2

const interiorParityCells = (
  boardWidth: number,
  boardHeight: number,
): { x: number; y: number }[] => {
  const cells: { x: number; y: number }[] = []
  for (let y = 1; y < boardHeight - 1; y++) {
    for (let x = 1; x < boardWidth - 1; x++) {
      if ((x + y) % 2 === 0) cells.push({ x, y })
    }
  }
  return cells
}

describe("radial slices", () => {
  test("cuts the circle into equal-angle slices", () => {
    const steps = 36000
    for (const sliceCount of [2, 3, 4, 5, 7]) {
      for (const rotation of [0, 0.4, TAU / 3, 5.9]) {
        const counts = new Array<number>(sliceCount).fill(0)
        for (let i = 0; i < steps; i++) {
          counts[sliceIndexForAngle((i * TAU) / steps, sliceCount, rotation)] += 1
        }
        counts.forEach((count) => {
          // Every slice covers 1/sliceCount of the circle, up to one sample of
          // rounding at each of its two boundaries.
          expect(Math.abs(count - steps / sliceCount)).toBeLessThanOrEqual(2)
        })
      }
    }
  })

  test("slice boundaries follow the rotation offset", () => {
    const sliceCount = 4
    const rotation = 0.7
    const epsilon = 1e-6
    for (let slice = 0; slice < sliceCount; slice++) {
      const start = rotation + (slice * TAU) / sliceCount
      expect(sliceIndexForAngle(start + epsilon, sliceCount, rotation)).toBe(slice)
      expect(sliceIndexForAngle(start - epsilon, sliceCount, rotation)).toBe(
        (slice + sliceCount - 1) % sliceCount,
      )
    }
  })

  test("overlap counts measure the cell's area, sampled on a sub-grid", () => {
    const counts = sliceOverlapCounts({ x: 2, y: 3 }, 11, 11, 4, 0)
    const total = counts.reduce((sum, count) => sum + count, 0)
    expect(total).toBe(SLICE_SAMPLES_PER_AXIS * SLICE_SAMPLES_PER_AXIS)

    // Quadrants split on the diagonals: a cell well inside one quadrant lies
    // wholly in that quadrant's slice.
    const insideCounts = sliceOverlapCounts({ x: 9, y: 6 }, 11, 11, 4, Math.PI / 4)
    expect(Math.max(...insideCounts)).toBe(SLICE_SAMPLES_PER_AXIS * SLICE_SAMPLES_PER_AXIS)

    // A cell straddling a boundary splits its area between the two slices.
    const straddleCounts = sliceOverlapCounts({ x: 9, y: 9 }, 11, 11, 4, Math.PI / 4)
    const nonEmpty = straddleCounts.filter((count) => count > 0)
    expect(nonEmpty.length).toBe(2)
  })

  test("assigns every cell exactly once, to a slice of maximum overlap", () => {
    const cells = interiorParityCells(21, 21)
    const sliceCount = 5
    const rotation = 1.23
    const slices = assignCellsToSlices(cells, 21, 21, sliceCount, rotation)

    expect(slices.length).toBe(sliceCount)
    const placed = slices.flat()
    expect(placed.length).toBe(cells.length)
    expect(new Set(placed.map((cell) => `${cell.x},${cell.y}`)).size).toBe(cells.length)

    slices.forEach((sliceCells, sliceIndex) => {
      sliceCells.forEach((cell) => {
        const counts = sliceOverlapCounts(cell, 21, 21, sliceCount, rotation)
        expect(counts[sliceIndex]).toBe(Math.max(...counts))
      })
    })
  })

  test("splits a square board evenly between its slices", () => {
    const cells = interiorParityCells(21, 21)
    const sliceCount = 4
    const slices = assignCellsToSlices(cells, 21, 21, sliceCount, Math.PI / 4)
    slices.forEach((sliceCells) => {
      expect(sliceCells.length).toBeGreaterThan((cells.length / sliceCount) * 0.8)
      expect(sliceCells.length).toBeLessThan((cells.length / sliceCount) * 1.2)
    })
  })

  test("breaks overlap ties uniformly at random", () => {
    // Halves split on the vertical axis: a cell centred on that axis overlaps
    // both slices equally.
    const tiedCell = { x: 5, y: 8 }
    const counts = sliceOverlapCounts(tiedCell, 11, 11, 2, Math.PI / 2)
    expect(counts[0]).toBe(counts[1])

    const chosen = [0, 0.99].map((draw) => {
      const slices = assignCellsToSlices([tiedCell], 11, 11, 2, Math.PI / 2, () => draw)
      return slices.findIndex((sliceCells) => sliceCells.length === 1)
    })
    expect(chosen).toEqual([0, 1])
  })

  test("measures circular distance between slices", () => {
    expect(sliceDistance(0, 0, 5)).toBe(0)
    expect(sliceDistance(0, 1, 5)).toBe(1)
    expect(sliceDistance(0, 4, 5)).toBe(1)
    expect(sliceDistance(1, 3, 5)).toBe(2)
  })
})
