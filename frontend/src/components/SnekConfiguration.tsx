import React, { useMemo } from "react"
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
  syncedPreviewData: BoardPresetData | null
  isGeneratingPreview: boolean
  onRefreshPreview: () => void
  gamePlayers: GamePlayer[]
  gameType: GameType
  teams?: Team[]
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
  usePreviewBoard, onUsePreviewBoardChange,
  syncedPreviewData,
  isGeneratingPreview, onRefreshPreview,
  gamePlayers, gameType, teams,
}) => {
  const activePlayers = useMemo(() => {
    const isTeamGame = gameType === "teamsnek" || gameType === "kingsnek"
    if (!isTeamGame) return gamePlayers
    return gamePlayers.filter(p => p.teamID)
  }, [gamePlayers, gameType])

  const displayData = useMemo(() => {
    if (!syncedPreviewData) return null
    return {
      fertileTiles: new Set(syncedPreviewData.fertileTiles),
      hazardTiles: new Set(syncedPreviewData.hazards),
      playerPositions: new Map(Object.entries(syncedPreviewData.playerPositions).map(([id, pos]) => [id, pos])),
      foodTiles: new Set(syncedPreviewData.food),
    }
  }, [syncedPreviewData])

  const playerPosToId = useMemo(() => {
    if (!displayData) return new Map<number, string>()
    const map = new Map<number, string>()
    displayData.playerPositions.forEach((pos, id) => map.set(pos, id))
    return map
  }, [displayData])

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
            {displayData ? (
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
                  const isHazard = displayData.hazardTiles.has(i)
                  const isFertile = displayData.fertileTiles.has(i)
                  const isFood = displayData.foodTiles.has(i)
                  const playerId = playerPosToId.get(i)
                  const isPlayer = !!playerId

                  let bg: string
                  if (isBorder) {
                    bg = "#1a1a1a"
                  } else if (isHazard) {
                    bg = "#c0392b"
                  } else if (isFertile) {
                    bg = getFertileTileColor(i, boardWidth, displayData.fertileTiles)
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
            ) : (
              <Box sx={{
                width: boardWidth * (cellSize + 1), height: boardHeight * (cellSize + 1),
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "1px solid #555", backgroundColor: "#2a2a2a",
                color: "#888",
              }}>
                <Typography variant="body2">Generating preview...</Typography>
              </Box>
            )}
            {isGeneratingPreview && displayData && (
              <Box sx={{
                position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                backgroundColor: "rgba(0,0,0,0.4)",
                zIndex: 1,
              }}>
                <RefreshCw
                  size={20}
                  style={{
                    color: "#fff",
                    animation: "spin 1s linear infinite",
                  }}
                />
                <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
              </Box>
            )}
            <IconButton
              size="small" onClick={onRefreshPreview}
              sx={{
                position: "absolute", bottom: 2, right: 2,
                backgroundColor: "rgba(0,0,0,0.5)", color: "#aaa", padding: "3px",
                "&:hover": { backgroundColor: "rgba(0,0,0,0.7)", color: "#fff" },
                zIndex: 2,
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
