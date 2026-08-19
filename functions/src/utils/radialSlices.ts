export interface SliceCell {
  x: number
  y: number
}

const TAU = Math.PI * 2

// Sub-grid resolution used to measure how much of a cell's area falls in each
// slice. 8x8 evenly spaced samples per cell keep the measurement stable
// without making board partitioning expensive.
export const SLICE_SAMPLES_PER_AXIS = 8

/**
 * Index of the equal-angle slice covering `angle` (radians, as returned by
 * Math.atan2) for a partition of `sliceCount` slices rotated by `rotation`.
 */
export const sliceIndexForAngle = (
  angle: number,
  sliceCount: number,
  rotation: number,
): number => {
  const normalized = (((angle - rotation) % TAU) + TAU) % TAU
  return Math.min(sliceCount - 1, Math.floor((normalized * sliceCount) / TAU))
}

/**
 * Area overlap between one board cell and each slice, measured by sampling the
 * cell's area on an evenly spaced sub-grid. Entry k is the number of samples
 * landing in slice k, so the counts are proportional to the overlapping areas
 * and sum to SLICE_SAMPLES_PER_AXIS squared.
 */
export const sliceOverlapCounts = (
  cell: SliceCell,
  boardWidth: number,
  boardHeight: number,
  sliceCount: number,
  rotation: number,
): number[] => {
  const centreX = boardWidth / 2
  const centreY = boardHeight / 2
  const counts = new Array<number>(sliceCount).fill(0)

  for (let sy = 0; sy < SLICE_SAMPLES_PER_AXIS; sy++) {
    for (let sx = 0; sx < SLICE_SAMPLES_PER_AXIS; sx++) {
      const dx = cell.x + (sx + 0.5) / SLICE_SAMPLES_PER_AXIS - centreX
      const dy = cell.y + (sy + 0.5) / SLICE_SAMPLES_PER_AXIS - centreY
      // A sample exactly on the centre has no angle and belongs to no slice.
      if (dx === 0 && dy === 0) continue
      counts[sliceIndexForAngle(Math.atan2(dy, dx), sliceCount, rotation)] += 1
    }
  }

  return counts
}

/**
 * Partition `cells` into `sliceCount` equal-angle pie slices radiating from the
 * board centre, the whole partition rotated by `rotation` radians. A cell joins
 * the slice overlapping most of its area; among slices tied for most overlap
 * one is chosen uniformly at random via `rng`. The returned array holds one
 * cell list per slice, indexed by slice.
 */
export const assignCellsToSlices = (
  cells: SliceCell[],
  boardWidth: number,
  boardHeight: number,
  sliceCount: number,
  rotation: number,
  rng: () => number = Math.random,
): SliceCell[][] => {
  const slices: SliceCell[][] = Array.from({ length: sliceCount }, () => [])

  cells.forEach((cell) => {
    const counts = sliceOverlapCounts(cell, boardWidth, boardHeight, sliceCount, rotation)
    const best = Math.max(...counts)
    if (best <= 0) return
    const tied: number[] = []
    counts.forEach((count, index) => {
      if (count === best) tied.push(index)
    })
    slices[tied[Math.floor(rng() * tied.length)] ?? tied[0]].push(cell)
  })

  return slices
}

/**
 * Circular distance between two slice indices, in slices. Used to walk outward
 * from a team's own slice when its slice cannot hold all of the team's units.
 */
export const sliceDistance = (a: number, b: number, sliceCount: number): number => {
  const raw = Math.abs(a - b) % sliceCount
  return Math.min(raw, sliceCount - raw)
}
