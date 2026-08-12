// Mid-tone colours chosen to stay legible on both dark and light backgrounds.
export const TEAM_COLOR_PALETTE: string[] = [
  "#E6194B", // crimson
  "#F58231", // orange
  "#C9A227", // gold
  "#3CB44B", // green
  "#2AA79B", // teal
  "#29ABE2", // sky blue
  "#4363D8", // royal blue
  "#7E57C2", // violet
  "#F032E6", // magenta
  "#8D6E63", // mocha
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
