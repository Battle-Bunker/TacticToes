import React, { useMemo, useRef, useEffect } from "react"
import { Checkbox, FormControl, FormControlLabel, IconButton, Slider, TextField, Typography, Box } from "@mui/material"
import { RefreshCw } from "lucide-react"
import { GamePlayer, GameType, Team } from "../../../shared/types/Game"

export interface BoardPresetData {
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
  usePreviewBoard: boolean
  onUsePreviewBoardChange: (enabled: boolean) => void
  onPreviewDataChange: (data: BoardPresetData, uncheckBoard: boolean) => void
  syncedPreviewData: BoardPresetData | null
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

function perlin(x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const x1 = x0 + 1, y1 = y0 + 1
  const sx = x - x0, sy = y - y0
  const tx = sx * sx * (3 - 2 * sx), ty = sy * sy * (3 - 2 * sy)
  const n00 = dotGridGradient(x0, y0, x, y)
  const n10 = dotGridGradient(x1, y0, x, y)
  const n01 = dotGridGradient(x0, y1, x, y)
  const n11 = dotGridGradient(x1, y1, x, y)
  return n00 * (1 - tx) * (1 - ty) + n10 * tx * (1 - ty) + n01 * (1 - tx) * ty + n11 * tx * ty
}

function fractalNoise(x: number, y: number, octaves: number, persistence: number): number {
  let total = 0, amplitude = 1, maxValue = 0
  let freq = 1
  for (let i = 0; i < octaves; i++) {
    total += perlin(x * freq, y * freq) * amplitude
    maxValue += amplitude
    amplitude *= persistence
    freq *= 2
  }
  return total / maxValue
}

function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

function clusteringToFrequency(c: number): number {
  return 0.7553 + ((c - 1) / 19) * (0.0662 - 0.7553)
}

function generatePreviewFertileTiles(
  w: number, h: number, density: number, clustering: number, seed: number, hazardSet: Set<number>
): Set<number> {
  const baseFreq = clusteringToFrequency(clustering)
  const offsetX = seed * 1000
  const offsetY = seed * 2000
  const innerTiles: { index: number; noise: number }[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x
      if (hazardSet.has(idx)) continue
      const n = fractalNoise((x + offsetX) * baseFreq, (y + offsetY) * baseFreq, 4, 0.5)
      innerTiles.push({ index: idx, noise: n })
    }
  }
  innerTiles.sort((a, b) => b.noise - a.noise)
  const count = Math.round((density / 100) * innerTiles.length)
  return new Set(innerTiles.slice(0, count).map(t => t.index))
}

function generatePreviewHazards(w: number, h: number, percentage: number, seed: number): Set<number> {
  if (percentage <= 0) return new Set()
  const innerTiles: number[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      innerTiles.push(y * w + x)
    }
  }
  const rng = seededRandom(Math.floor(seed * 100000))
  for (let i = innerTiles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [innerTiles[i], innerTiles[j]] = [innerTiles[j], innerTiles[i]]
  }
  const count = Math.round((percentage / 100) * innerTiles.length)
  return new Set(innerTiles.slice(0, count))
}

function generatePlayerPositions(
  w: number, h: number, players: GamePlayer[], gameType: GameType,
  teams: Team[] | undefined, teamClustersEnabled: boolean,
  hazardSet: Set<number>, seed: number
): Map<string, number> {
  const positions = new Map<string, number>()
  if (players.length === 0) return positions

  const isTeamGame = gameType === "teamsnek" || gameType === "kingsnek"
  const usedPositions = new Set<number>()

  const isValidPos = (x: number, y: number): boolean => {
    if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) return false
    const idx = y * w + x
    return !hazardSet.has(idx) && !usedPositions.has(idx)
  }

  const claimPos = (x: number, y: number, playerId: string): boolean => {
    if (!isValidPos(x, y)) return false
    const idx = y * w + x
    usedPositions.add(idx)
    positions.set(playerId, idx)
    return true
  }

  if (isTeamGame && teamClustersEnabled && teams && teams.length > 0) {
    const innerW = w - 2
    const innerH = h - 2
    const cx = innerW / 2 + 1
    const cy = innerH / 2 + 1
    const rx = (innerW - 2) / 2
    const ry = (innerH - 2) / 2
    const rng = seededRandom(Math.floor(seed * 100000))
    const angleOffset = rng() * Math.PI * 2

    const teamPlayers: Map<string, GamePlayer[]> = new Map()
    players.forEach(p => {
      const tid = p.teamID || "unassigned"
      if (!teamPlayers.has(tid)) teamPlayers.set(tid, [])
      teamPlayers.get(tid)!.push(p)
    })

    const teamIds = Array.from(teamPlayers.keys())
    const totalPlayers = players.length
    let currentAngle = angleOffset

    teamIds.forEach(tid => {
      const tp = teamPlayers.get(tid)!
      const segmentSize = (2 * Math.PI * tp.length) / totalPlayers

      tp.forEach((player, i) => {
        const angle = currentAngle + (segmentSize * (i + 0.5)) / tp.length
        const x = Math.round(cx + rx * Math.cos(angle))
        const y = Math.round(cy + ry * Math.sin(angle))
        if (!claimPos(x, y, player.id)) {
          for (let r = 1; r <= 3; r++) {
            for (let dx = -r; dx <= r; dx++) {
              for (let dy = -r; dy <= r; dy++) {
                if (claimPos(x + dx, y + dy, player.id)) return
              }
            }
          }
        }
      })

      currentAngle += segmentSize
    })

    if (positions.size === players.length) return positions
    positions.clear()
    usedPositions.clear()
  }

  const edgePositions: { x: number; y: number }[] = []

  const corners = [
    { x: 1, y: 1 }, { x: w - 2, y: 1 },
    { x: 1, y: h - 2 }, { x: w - 2, y: h - 2 },
  ]
  corners.forEach(c => { if (isValidPos(c.x, c.y)) edgePositions.push(c) })

  const getMidpoints = (points: { x: number; y: number }[], depth: number): { x: number; y: number }[] => {
    if (depth <= 0) return []
    const mids: { x: number; y: number }[] = []
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]
      const mx = Math.round((a.x + b.x) / 2)
      const my = Math.round((a.y + b.y) / 2)
      if (isValidPos(mx, my) && !edgePositions.some(p => p.x === mx && p.y === my)) {
        mids.push({ x: mx, y: my })
      }
    }
    mids.forEach(m => { if (!edgePositions.some(p => p.x === m.x && p.y === m.y)) edgePositions.push(m) })
    return mids.length > 0 ? getMidpoints([...points, ...mids].sort((a, b) => {
      const angleA = Math.atan2(a.y - h / 2, a.x - w / 2)
      const angleB = Math.atan2(b.y - h / 2, b.x - w / 2)
      return angleA - angleB
    }), depth - 1) : []
  }

  if (edgePositions.length < players.length) {
    getMidpoints(corners, 4)
  }

  const fillInnerPositions = () => {
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (isValidPos(x, y)) edgePositions.push({ x, y })
        if (edgePositions.length >= players.length) return
      }
    }
  }
  if (edgePositions.length < players.length) fillInnerPositions()

  players.forEach((player, i) => {
    if (i < edgePositions.length) {
      claimPos(edgePositions[i].x, edgePositions[i].y, player.id)
    }
  })

  return positions
}

function generatePreviewFood(
  w: number, h: number, playerPositions: Map<string, number>,
  hazardSet: Set<number>, _seed: number
): Set<number> {
  const food = new Set<number>()
  const occupied = new Set<number>()

  for (let x = 0; x < w; x++) { occupied.add(x); occupied.add((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { occupied.add(y * w); occupied.add(y * w + w - 1) }
  hazardSet.forEach(h => occupied.add(h))
  playerPositions.forEach(pos => occupied.add(pos))

  const centerX = Math.floor(w / 2)
  const centerY = Math.floor(h / 2)
  const centerIdx = centerY * w + centerX
  if (!occupied.has(centerIdx)) {
    food.add(centerIdx)
    occupied.add(centerIdx)
  }

  playerPositions.forEach((pos) => {
    const headX = pos % w
    const headY = Math.floor(pos / w)
    const diags = [
      { dx: 1, dy: 1 }, { dx: -1, dy: -1 },
      { dx: 1, dy: -1 }, { dx: -1, dy: 1 },
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
  const hueShift = ((px + py) % 3) * 5
  return `hsl(${105 + hueShift}, ${saturation}%, ${lightness}%)`
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
  usePreviewBoard, onUsePreviewBoardChange,
  onPreviewDataChange, syncedPreviewData,
  gamePlayers, gameType, teams, teamClustersEnabled,
}) => {
  const [previewSeed, setPreviewSeed] = React.useState(() => Math.random())
  const [hazardSeed, setHazardSeed] = React.useState(() => Math.random())
  const [placementSeed, setPlacementSeed] = React.useState(() => Math.random())
  const localChangeRef = useRef(false)
  const didMountRef = useRef(false)

  useEffect(() => {
    didMountRef.current = true
  }, [])

  const markLocalChange = () => { localChangeRef.current = true }

  React.useEffect(() => {
    if (!didMountRef.current) return
    markLocalChange()
    setPreviewSeed(Math.random())
  }, [fertileGroundEnabled])

  React.useEffect(() => {
    if (!didMountRef.current) return
    markLocalChange()
    setPreviewSeed(Math.random())
  }, [fertileGroundDensity, fertileGroundClustering])

  React.useEffect(() => {
    if (!didMountRef.current) return
    markLocalChange()
    setHazardSeed(Math.random())
  }, [hazardPercentage])

  React.useEffect(() => {
    if (!didMountRef.current) return
    markLocalChange()
    setPreviewSeed(Math.random())
    setHazardSeed(Math.random())
    setPlacementSeed(Math.random())
  }, [boardWidth, boardHeight])

  React.useEffect(() => {
    if (!didMountRef.current) return
    markLocalChange()
    setPlacementSeed(Math.random())
  }, [gamePlayers.length, teamClustersEnabled, gameType])

  const playerIds = gamePlayers.map(p => p.id).sort().join(",")
  const teamIds = gamePlayers.map(p => p.teamID || "").sort().join(",")
  React.useEffect(() => {
    if (!didMountRef.current) return
    markLocalChange()
    setPlacementSeed(Math.random())
  }, [playerIds, teamIds])

  const localHazardTiles = useMemo(() => {
    return generatePreviewHazards(boardWidth, boardHeight, hazardPercentage, hazardSeed)
  }, [boardWidth, boardHeight, hazardPercentage, hazardSeed])

  const localFertileTiles = useMemo(() => {
    if (!fertileGroundEnabled) return new Set<number>()
    return generatePreviewFertileTiles(boardWidth, boardHeight, fertileGroundDensity, fertileGroundClustering, previewSeed, localHazardTiles)
  }, [fertileGroundEnabled, fertileGroundDensity, fertileGroundClustering, previewSeed, boardWidth, boardHeight, localHazardTiles])

  const activePlayers = useMemo(() => {
    const isTeamGame = gameType === "teamsnek" || gameType === "kingsnek"
    if (!isTeamGame) return gamePlayers
    return gamePlayers.filter(p => p.teamID)
  }, [gamePlayers, gameType])

  const localPlayerPositions = useMemo(() => {
    return generatePlayerPositions(boardWidth, boardHeight, activePlayers, gameType, teams, teamClustersEnabled, localHazardTiles, placementSeed)
  }, [boardWidth, boardHeight, activePlayers, gameType, teams, teamClustersEnabled, localHazardTiles, placementSeed])

  const localFoodTiles = useMemo(() => {
    return generatePreviewFood(boardWidth, boardHeight, localPlayerPositions, localHazardTiles, placementSeed)
  }, [boardWidth, boardHeight, localPlayerPositions, localHazardTiles, placementSeed])

  useEffect(() => {
    if (!localChangeRef.current) return
    localChangeRef.current = false

    const posObj: { [id: string]: number } = {}
    localPlayerPositions.forEach((pos, id) => { posObj[id] = pos })
    onPreviewDataChange({
      fertileTiles: Array.from(localFertileTiles),
      hazards: Array.from(localHazardTiles),
      playerPositions: posObj,
      food: Array.from(localFoodTiles),
    }, usePreviewBoard)
  }, [localFertileTiles, localHazardTiles, localPlayerPositions, localFoodTiles])

  const displayData = useMemo(() => {
    if (syncedPreviewData && !localChangeRef.current) {
      return {
        fertileTiles: new Set(syncedPreviewData.fertileTiles),
        hazardTiles: new Set(syncedPreviewData.hazards),
        playerPositions: new Map(Object.entries(syncedPreviewData.playerPositions).map(([id, pos]) => [id, pos])),
        foodTiles: new Set(syncedPreviewData.food),
      }
    }
    return {
      fertileTiles: localFertileTiles,
      hazardTiles: localHazardTiles,
      playerPositions: localPlayerPositions,
      foodTiles: localFoodTiles,
    }
  }, [syncedPreviewData, localFertileTiles, localHazardTiles, localPlayerPositions, localFoodTiles])

  const { fertileTiles, hazardTiles, playerPositions, foodTiles } = displayData

  const handleRefresh = React.useCallback(() => {
    markLocalChange()
    setPreviewSeed(Math.random())
    setHazardSeed(Math.random())
    setPlacementSeed(Math.random())
  }, [])

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
                  bg = "#c0392b"
                } else if (isFertile) {
                  bg = getFertileTileColor(i, boardWidth, fertileTiles)
                } else {
                  bg = "#2a2a2a"
                }

                let content: React.ReactNode = null
                if (isPlayer && playerId) {
                  const player = activePlayers.find(p => p.id === playerId)
                  const teamColor = getTeamColor(player?.teamID, teams)
                  const playerIdx = activePlayers.findIndex(p => p.id === playerId)
                  const color = teamColor || getPlayerColor(playerIdx, activePlayers.length)
                  content = (
                    <Box sx={{
                      width: "100%", height: "100%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: Math.max(8, cellSize - 2), fontWeight: "bold",
                      color, lineHeight: 1,
                    }}>✕</Box>
                  )
                } else if (isFood) {
                  content = (
                    <Box sx={{
                      width: "60%", height: "60%",
                      backgroundColor: "#e67e22", borderRadius: "50%",
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
                checked={usePreviewBoard}
                onChange={(e) => onUsePreviewBoardChange(e.target.checked)}
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
