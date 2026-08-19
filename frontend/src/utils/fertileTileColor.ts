// Grass-like coloring for fertile ground tiles. Deterministic per tile:
// a positional noise term plus the count of adjacent fertile tiles picks
// the HSL values, so denser patches render darker/more saturated.
// Used by SnekConfiguration's board preview.
export function getFertileTileColor(index: number, w: number, fertileSet: Set<number>): string {
  const px = index % w
  const py = Math.floor(index / w)
  const adjacentCount = [
    fertileSet.has(index - 1), fertileSet.has(index + 1),
    fertileSet.has(index - w), fertileSet.has(index + w),
    fertileSet.has(index - w - 1), fertileSet.has(index - w + 1),
    fertileSet.has(index + w - 1), fertileSet.has(index + w + 1),
  ].filter(Boolean).length
  const noise = ((px * 7 + py * 13) % 5)
  const lightness = adjacentCount >= 6 ? 78 + noise : adjacentCount >= 3 ? 82 + noise : 86 + noise
  const saturation = adjacentCount >= 6 ? 60 : adjacentCount >= 3 ? 50 : 40
  const hue = 42 + (noise - 2)
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}
