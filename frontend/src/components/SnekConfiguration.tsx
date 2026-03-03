import React, { useMemo } from "react"
import { Checkbox, FormControl, FormControlLabel, IconButton, Slider, TextField, Typography, Box } from "@mui/material"
import { RefreshCw } from "lucide-react"
import { GamePlayer, GameType, Team } from "../../../shared/types/Game"

interface BoardPresetData {
  fertileTiles: number[]
  hazards: number[]
  playerPositions: { [playerID: string]: number }
  food: number[]
}

interface SnekConfigurationProps {
  maxTurns: number
  maxTurnsEnabled: boolean
  onMaxTurnsToggle: (enabled: boolean) => void
  onMaxTurnsChange: (turns: number) => void
  hazardPercentage: number
  onHazardPercentageChange: (percentage: number) => void
  fertileGroundEnabled: boolean
  onFertileGroundToggle: (enabled: boolean) => void
  fertileGroundDensity: number
  onFertileGroundDensityChange: (density: number) => void
  fertileGroundClustering: number
  onFertileGroundClusteringChange: (clustering: number) => void
  foodSpawnRate: number
  onFoodSpawnRateChange: (rate: number) => void
  boardWidth: number
  boardHeight: number
  useThisBoard: boolean
  onUseThisBoardChange: (enabled: boolean, data: BoardPresetData) => void
  gamePlayers: GamePlayer[]
  gameType: GameType
  teams?: Team[]
  teamClustersEnabled: boolean
}

function hashCoord(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1013904223) & 0x7fffffff
  h = ((h >> 13) ^ h) & 0x7fffffff
  h = (h * 1274126177 + 1013904223) & 0x7fffffff
  return (h & 0xffff) / 0xffff
}

function dotGridGradient(ix: number, iy: number, x: number, y: number): number {
  const hash = hashCoord(ix, iy)
  const angle = hash * 2.0 * Math.PI
  return Math.cos(angle) * (x - ix) + Math.sin(angle) * (y - iy)
}

function perlinNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const dx = x - x0
  const dy = y - y0
  const sx = dx * dx * (3 - 2 * dx)
  const sy = dy * dy * (3 - 2 * dy)
  const n00 = dotGridGradient(x0, y0, x, y)
  const n10 = dotGridGradient(x0 + 1, y0, x, y)
  const n01 = dotGridGradient(x0, y0 + 1, x, y)
  const n11 = dotGridGradient(x0 + 1, y0 + 1, x, y)
  const ix0 = n00 + sx * (n10 - n00)
  const ix1 = n01 + sx * (n11 - n01)
  return ix0 + sy * (ix1 - ix0)
}

function fractalNoise(x: number, y: number, octaves: number, baseFrequency: number): number {
  let value = 0
  let amplitude = 1
  let frequency = baseFrequency
  let maxAmplitude = 0
  for (let i = 0; i < octaves; i++) {
    value += perlinNoise(x * frequency, y * frequency) * amplitude
    maxAmplitude += amplitude
    amplitude *= 0.5
    frequency *= 2.0
  }
  return value / maxAmplitude
}

function clusteringToFrequency(clustering: number): number {
  const t = (clustering - 1) / 19
  return 0.7553 + t * (0.0662 - 0.7553)
}

function seededRandom(seed: number): () => number {
  let s = Math.floor(seed)
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function generatePreviewFertileTiles(
  w: number, h: number, density: number, clustering: number, seed: number, hazardSet: Set<number>
): Set<number> {
  const baseFrequency = clusteringToFrequency(clustering)
  const seedX = seed * 1000
  const seedY = (seed * 577.215 + 0.331) * 1000 % 1000
  const noiseValues: { pos: number; value: number }[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const pos = y * w + x
      if (hazardSet.has(pos)) continue
      const value = fractalNoise(x + seedX, y + seedY, 4, baseFrequency)
      noiseValues.push({ pos, value })
    }
  }
  noiseValues.sort((a, b) => b.value - a.value)
  const targetCount = Math.max(1, Math.floor((noiseValues.length * density) / 100))
  return new Set(noiseValues.slice(0, targetCount).map(n => n.pos))
}

function generatePreviewHazards(w: number, h: number, percentage: number, seed: number): Set<number> {
  if (percentage <= 0) return new Set()
  const rand = seededRandom(seed * 100000)
  const candidates: number[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      candidates.push(y * w + x)
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  const targetCount = Math.max(0, Math.floor((candidates.length * percentage) / 100))
  return new Set(candidates.slice(0, targetCount))
}

function generatePlayerPositions(
  w: number, h: number, players: GamePlayer[], gameType: GameType,
  teams: Team[] | undefined, teamClustersEnabled: boolean,
  hazardSet: Set<number>, seed: number
): Map<string, number> {
  const positions = new Map<string, number>()
  if (players.length === 0) return positions

  const rand = seededRandom(seed * 77777)
  const occupied = new Set<number>()

  const isTeamGame = gameType === "teamsnek" || gameType === "kingsnek"

  if (isTeamGame && teamClustersEnabled && teams && teams.length > 0) {
    const teamMap = new Map<string, GamePlayer[]>()
    players.forEach(p => {
      if (!p.teamID) return
      const list = teamMap.get(p.teamID) || []
      list.push(p)
      teamMap.set(p.teamID, list)
    })

    const activeTeams = teams.filter(t => teamMap.has(t.id))
    if (activeTeams.length > 0) {
      const ringInset = Math.max(2, Math.floor(Math.min(w, h) / 2) - 6)
      const ringPositions: { x: number; y: number }[] = []

      const x1 = ringInset
      const y1 = ringInset
      const x2 = w - 1 - ringInset
      const y2 = h - 1 - ringInset

      if (x2 > x1 && y2 > y1) {
        for (let x = x1; x <= x2; x++) ringPositions.push({ x, y: y1 })
        for (let y = y1 + 1; y <= y2; y++) ringPositions.push({ x: x2, y })
        for (let x = x2 - 1; x >= x1; x--) ringPositions.push({ x, y: y2 })
        for (let y = y2 - 1; y > y1; y--) ringPositions.push({ x: x1, y })

        const rotation = Math.floor(rand() * ringPositions.length)
        const rotated = [...ringPositions.slice(rotation), ...ringPositions.slice(0, rotation)]
        const segmentLength = Math.floor(rotated.length / activeTeams.length)

        let allPlaced = true
        activeTeams.forEach((team, teamIdx) => {
          const teamPlayers = teamMap.get(team.id) || []
          const segStart = teamIdx * segmentLength
          const segEnd = teamIdx === activeTeams.length - 1 ? rotated.length : (teamIdx + 1) * segmentLength
          const segPositions = rotated.slice(segStart, segEnd)

          const spacing = Math.max(1, Math.floor(segPositions.length / (teamPlayers.length + 1)))
          teamPlayers.forEach((player, pIdx) => {
            const ringIdx = Math.min(spacing * (pIdx + 1), segPositions.length - 1)
            const pos = segPositions[ringIdx]
            if (pos) {
              const idx = pos.y * w + pos.x
              if (!hazardSet.has(idx) && !occupied.has(idx)) {
                positions.set(player.id, idx)
                occupied.add(idx)
              } else {
                allPlaced = false
              }
            } else {
              allPlaced = false
            }
          })
        })

        if (allPlaced && positions.size === players.length) return positions
      }

      positions.clear()
      occupied.clear()
    }
  }

  const startX = (w - 1) % 4 === 0 ? 2 : 1
  const startY = (h - 1) % 4 === 0 ? 2 : 1
  const endX = w - startX - 1
  const endY = h - startY - 1

  const edgePositions: { x: number; y: number }[] = []
  const addUnique = (pos: { x: number; y: number }) => {
    if (!edgePositions.some(p => p.x === pos.x && p.y === pos.y)) {
      edgePositions.push(pos)
    }
  }

  addUnique({ x: startX, y: startY })
  addUnique({ x: endX, y: startY })
  addUnique({ x: startX, y: endY })
  addUnique({ x: endX, y: endY })

  const edges = [
    { start: { x: startX, y: startY }, end: { x: endX, y: startY } },
    { start: { x: endX, y: startY }, end: { x: endX, y: endY } },
    { start: { x: endX, y: endY }, end: { x: startX, y: endY } },
    { start: { x: startX, y: endY }, end: { x: startX, y: startY } },
  ]

  let depth = 0
  while (edgePositions.length < players.length && depth < 10) {
    for (const edge of edges) {
      const midpoints = getMidpoints(edge.start, edge.end, depth)
      midpoints.forEach(p => addUnique(p))
    }
    depth++
  }

  players.forEach((player, i) => {
    if (i < edgePositions.length) {
      const pos = edgePositions[i]
      const idx = pos.y * w + pos.x
      if (!hazardSet.has(idx)) {
        positions.set(player.id, idx)
        occupied.add(idx)
      }
    }
  })

  return positions
}

function getMidpoints(
  start: { x: number; y: number }, end: { x: number; y: number }, depth: number
): { x: number; y: number }[] {
  const count = Math.pow(2, depth)
  const results: { x: number; y: number }[] = []
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1)
    const x = Math.round(start.x + t * (end.x - start.x))
    const y = Math.round(start.y + t * (end.y - start.y))
    results.push({ x, y })
  }
  return results
}

function generatePreviewFood(
  w: number, h: number, playerPositions: Map<string, number>,
  hazardSet: Set<number>, _seed: number
): Set<number> {
  const food = new Set<number>()
  const occupied = new Set<number>([...hazardSet, ...playerPositions.values()])

  for (let x = 0; x < w; x++) {
    occupied.add(x)
    occupied.add((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    occupied.add(y * w)
    occupied.add(y * w + w - 1)
  }

  const centerX = Math.floor(w / 2)
  const centerY = Math.floor(h / 2)
  const centerPos = centerY * w + centerX
  if (!occupied.has(centerPos)) {
    food.add(centerPos)
    occupied.add(centerPos)
  }

  playerPositions.forEach((headPos) => {
    const headX = headPos % w
    const headY = Math.floor(headPos / w)
    const diags = [
      { dx: 1, dy: 1 }, { dx: 1, dy: -1 },
      { dx: -1, dy: 1 }, { dx: -1, dy: -1 },
    ]
    for (const { dx, dy } of diags) {
      const fx = headX + dx
      const fy = headY + dy
      if (fx >= 1 && fx < w - 1 && fy >= 1 && fy < h - 1) {
        const fp = fy * w + fx
        if (!occupied.has(fp)) {
          food.add(fp)
          occupied.add(fp)
          break
        }
      }
    }
  })

  return food
}

function getFertileTileColor(index: number, w: number, fertileSet: Set<number>): string {
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

function getPlayerColor(index: number, total: number): string {
  const hue = (index * 360 / Math.max(total, 1)) % 360
  return `hsl(${hue}, 70%, 55%)`
}

function getTeamColor(teamID: string | undefined, teams: Team[] | undefined): string | null {
  if (!teamID || !teams) return null
  const team = teams.find(t => t.id === teamID)
  return team?.color || null
}

export const SnekConfiguration: React.FC<SnekConfigurationProps> = ({
  maxTurns, maxTurnsEnabled, onMaxTurnsToggle, onMaxTurnsChange,
  hazardPercentage, onHazardPercentageChange,
  fertileGroundEnabled, onFertileGroundToggle,
  fertileGroundDensity, onFertileGroundDensityChange,
  fertileGroundClustering, onFertileGroundClusteringChange,
  foodSpawnRate, onFoodSpawnRateChange,
  boardWidth, boardHeight,
  useThisBoard, onUseThisBoardChange,
  gamePlayers, gameType, teams, teamClustersEnabled,
}) => {
  const [previewSeed, setPreviewSeed] = React.useState(() => Math.random())
  const [hazardSeed, setHazardSeed] = React.useState(() => Math.random())
  const [placementSeed, setPlacementSeed] = React.useState(() => Math.random())

  const emptyPreset: BoardPresetData = { fertileTiles: [], hazards: [], playerPositions: {}, food: [] }

  const uncheckBoard = React.useCallback(() => {
    if (useThisBoard) onUseThisBoardChange(false, emptyPreset)
  }, [useThisBoard, onUseThisBoardChange])

  React.useEffect(() => { uncheckBoard() }, [fertileGroundEnabled])

  React.useEffect(() => {
    setPreviewSeed(Math.random())
    uncheckBoard()
  }, [fertileGroundDensity, fertileGroundClustering])

  React.useEffect(() => {
    setHazardSeed(Math.random())
    uncheckBoard()
  }, [hazardPercentage])

  React.useEffect(() => {
    setPreviewSeed(Math.random())
    setHazardSeed(Math.random())
    setPlacementSeed(Math.random())
    uncheckBoard()
  }, [boardWidth, boardHeight])

  React.useEffect(() => {
    setPlacementSeed(Math.random())
    uncheckBoard()
  }, [gamePlayers.length, teamClustersEnabled, gameType])

  const playerIds = gamePlayers.map(p => p.id).sort().join(",")
  const teamIds = gamePlayers.map(p => p.teamID || "").sort().join(",")
  React.useEffect(() => {
    setPlacementSeed(Math.random())
    uncheckBoard()
  }, [playerIds, teamIds])

  const hazardTiles = useMemo(() => {
    return generatePreviewHazards(boardWidth, boardHeight, hazardPercentage, hazardSeed)
  }, [boardWidth, boardHeight, hazardPercentage, hazardSeed])

  const fertileTiles = useMemo(() => {
    if (!fertileGroundEnabled) return new Set<number>()
    return generatePreviewFertileTiles(boardWidth, boardHeight, fertileGroundDensity, fertileGroundClustering, previewSeed, hazardTiles)
  }, [fertileGroundEnabled, fertileGroundDensity, fertileGroundClustering, previewSeed, boardWidth, boardHeight, hazardTiles])

  const playerPositions = useMemo(() => {
    return generatePlayerPositions(boardWidth, boardHeight, gamePlayers, gameType, teams, teamClustersEnabled, hazardTiles, placementSeed)
  }, [boardWidth, boardHeight, gamePlayers, gameType, teams, teamClustersEnabled, hazardTiles, placementSeed])

  const foodTiles = useMemo(() => {
    return generatePreviewFood(boardWidth, boardHeight, playerPositions, hazardTiles, placementSeed)
  }, [boardWidth, boardHeight, playerPositions, hazardTiles, placementSeed])

  const handleRefresh = React.useCallback(() => {
    setPreviewSeed(Math.random())
    setHazardSeed(Math.random())
    setPlacementSeed(Math.random())
    if (useThisBoard) onUseThisBoardChange(false, emptyPreset)
  }, [useThisBoard, onUseThisBoardChange])

  const playerPosToId = useMemo(() => {
    const map = new Map<number, string>()
    playerPositions.forEach((pos, id) => map.set(pos, id))
    return map
  }, [playerPositions])

  const showPreview = fertileGroundEnabled || hazardPercentage > 0 || gamePlayers.length > 0
  const clusteringLabel = fertileGroundClustering <= 6 ? "Scattered" : fertileGroundClustering <= 14 ? "Clustered" : "Blobby"
  const cellSize = Math.max(6, Math.min(16, Math.floor(280 / Math.max(boardWidth, boardHeight))))

  return (
    <FormControl fullWidth margin="normal">
      <div style={{ display: "flex", gap: "15px" }}>
        <FormControlLabel
          control={<Checkbox checked={maxTurnsEnabled} onChange={(e) => onMaxTurnsToggle(e.target.checked)} />}
          label="Enable Turn Limit"
        />
        <TextField
          type="number" label="Max Turns" value={maxTurns}
          onChange={(e) => onMaxTurnsChange(parseInt(e.target.value) || 0)}
          sx={{ flex: 1 }} inputProps={{ min: 1 }} disabled={!maxTurnsEnabled}
        />
      </div>
      <Box sx={{ mt: 1 }}>
        <Typography variant="body2" gutterBottom>Hazard Percentage: {hazardPercentage}%</Typography>
        <Slider
          value={hazardPercentage} onChange={(_e, value) => onHazardPercentageChange(value as number)}
          min={0} max={100} step={1} valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`} sx={{ mx: 1 }}
        />
      </Box>
      <Box sx={{ mt: 1 }}>
        <Typography variant="body2" gutterBottom>Food Spawn Rate: {foodSpawnRate}/turn</Typography>
        <Slider
          value={foodSpawnRate} onChange={(_e, value) => onFoodSpawnRateChange(value as number)}
          min={0} max={5} step={0.25} valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}/turn`} sx={{ mx: 1 }}
        />
      </Box>
      <Box sx={{ mt: 1 }}>
        <FormControlLabel
          control={<Checkbox checked={fertileGroundEnabled} onChange={(e) => onFertileGroundToggle(e.target.checked)} />}
          label="Fertile Ground"
        />
        {fertileGroundEnabled && (
          <Box sx={{ ml: 4, mr: 1, mt: 1 }}>
            <Typography variant="body2" gutterBottom>Fertile Density: {fertileGroundDensity}%</Typography>
            <Slider
              value={fertileGroundDensity} onChange={(_e, value) => onFertileGroundDensityChange(value as number)}
              min={5} max={80} step={5} valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
            />
            <Typography variant="body2" gutterBottom sx={{ mt: 1 }}>Clustering: {fertileGroundClustering} — {clusteringLabel}</Typography>
            <Slider
              value={fertileGroundClustering} onChange={(_e, value) => onFertileGroundClusteringChange(value as number)}
              min={1} max={20} step={1} marks valueLabelDisplay="auto"
            />
          </Box>
        )}
      </Box>
      {showPreview && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 0.5 }}>
            Preview ({boardWidth}×{boardHeight})
          </Typography>
          <Box sx={{ position: "relative", width: "fit-content" }}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: `repeat(${boardWidth}, 1fr)`,
                gap: "1px", width: "fit-content",
                border: "1px solid #555", backgroundColor: "#555",
              }}
            >
              {Array.from({ length: boardWidth * boardHeight }, (_, i) => {
                const x = i % boardWidth
                const y = Math.floor(i / boardWidth)
                const isBorder = x === 0 || x === boardWidth - 1 || y === 0 || y === boardHeight - 1
                const isHazard = hazardTiles.has(i)
                const isFertile = fertileTiles.has(i)
                const isFood = foodTiles.has(i)
                const playerId = playerPosToId.get(i)
                const isPlayer = !!playerId

                let bg: string
                if (isBorder) {
                  bg = "#1a1a1a"
                } else if (isHazard) {
                  bg = "#b71c1c"
                } else if (isFertile) {
                  bg = getFertileTileColor(i, boardWidth, fertileTiles)
                } else {
                  bg = "#2a2a2a"
                }

                let content: React.ReactNode = null
                if (isPlayer && playerId) {
                  const player = gamePlayers.find(p => p.id === playerId)
                  const teamColor = getTeamColor(player?.teamID, teams)
                  const playerIdx = gamePlayers.findIndex(p => p.id === playerId)
                  const color = teamColor || getPlayerColor(playerIdx, gamePlayers.length)
                  content = (
                    <Box sx={{
                      width: "100%", height: "100%",
                      backgroundColor: color, borderRadius: "2px",
                    }} />
                  )
                } else if (isFood) {
                  content = (
                    <Box sx={{
                      width: "60%", height: "60%",
                      backgroundColor: "#ff9800", borderRadius: "50%",
                      margin: "auto",
                    }} />
                  )
                }

                return (
                  <Box
                    key={i}
                    sx={{
                      width: cellSize, height: cellSize,
                      backgroundColor: bg,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {content}
                  </Box>
                )
              })}
            </Box>
            <IconButton
              size="small" onClick={handleRefresh}
              sx={{
                position: "absolute", bottom: 2, right: 2,
                backgroundColor: "rgba(0,0,0,0.5)", color: "#aaa", padding: "3px",
                "&:hover": { backgroundColor: "rgba(0,0,0,0.7)", color: "#fff" },
              }}
            >
              <RefreshCw size={14} />
            </IconButton>
          </Box>
          <FormControlLabel
            control={
              <Checkbox
                checked={useThisBoard}
                onChange={(e) => {
                  const checked = e.target.checked
                  if (checked) {
                    const posObj: { [id: string]: number } = {}
                    playerPositions.forEach((pos, id) => { posObj[id] = pos })
                    onUseThisBoardChange(true, {
                      fertileTiles: Array.from(fertileTiles),
                      hazards: Array.from(hazardTiles),
                      playerPositions: posObj,
                      food: Array.from(foodTiles),
                    })
                  } else {
                    onUseThisBoardChange(false, emptyPreset)
                  }
                }}
              />
            }
            label="Use this board"
            sx={{ mt: 1 }}
          />
        </Box>
      )}
    </FormControl>
  )
}
