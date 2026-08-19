// Ordered for maximal pairwise OKLab distance in every prefix (farthest-point
// walk), and kept clear of the board's reserved hues: fertile-ground yellow,
// hazard red, food orange, the selection purple, the sky-blue orientation eye,
// and the white/black/grey neutrals. Yellows and yellow-greens are excluded
// outright. Assignment is by arrival order (nextTeamColor takes the first
// unused entry), so a team's colour is predictable from when it was created.
// Kept in lockstep with the operator palette in Chris-Centaur's
// src/shared/player-palette.ts.
export const TEAM_COLOR_PALETTE: string[] = [
  "#156cdd", // azure
  "#ff4d6d", // coral rose
  "#0a7e3a", // emerald
  "#8629c0", // violet
  "#119ba7", // cyan-teal
  "#c70389", // magenta
  "#88411a", // rust brown
  "#12cdae", // turquoise
  "#9b84ff", // periwinkle
  "#05556f", // deep petrol
  "#8e0746", // crimson wine
  "#06726e", // deep teal-green
]

const hslToHex = (h: number, s: number, l: number): string => {
  const sat = s / 100
  const light = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(light, 1 - light)
  const channel = (n: number) => {
    const value = light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase()
}

export const nextTeamColor = (used: string[]): string => {
  const usedSet = new Set(used.map((c) => c.toLowerCase()))
  const available = TEAM_COLOR_PALETTE.find(
    (c) => !usedSet.has(c.toLowerCase()),
  )
  if (available) return available
  return hslToHex(Math.floor(Math.random() * 360), 70, 55)
}
