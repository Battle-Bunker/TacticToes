import React, { useMemo } from "react"
import { Checkbox, FormControl, FormControlLabel, IconButton, Slider, TextField, Typography, Box } from "@mui/material"
import { RefreshCw } from "lucide-react"

const PREVIEW_SIZE = 17

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
  const gx = Math.cos(angle)
  const gy = Math.sin(angle)
  return gx * (x - ix) + gy * (y - iy)
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

function generatePreviewTiles(density: number, clustering: number, seed: number): Set<number> {
  const baseFrequency = clusteringToFrequency(clustering)
  const seedX = seed * 1000
  const seedY = (seed * 577.215 + 0.331) * 1000 % 1000

  const noiseValues: { pos: number; value: number }[] = []
  for (let y = 1; y < PREVIEW_SIZE - 1; y++) {
    for (let x = 1; x < PREVIEW_SIZE - 1; x++) {
      const pos = y * PREVIEW_SIZE + x
      const value = fractalNoise(x + seedX, y + seedY, 4, baseFrequency)
      noiseValues.push({ pos, value })
    }
  }

  noiseValues.sort((a, b) => b.value - a.value)
  const targetCount = Math.max(1, Math.floor((noiseValues.length * density) / 100))
  return new Set(noiseValues.slice(0, targetCount).map(n => n.pos))
}

function isBorderTile(index: number): boolean {
  const x = index % PREVIEW_SIZE
  const y = Math.floor(index / PREVIEW_SIZE)
  return x === 0 || x === PREVIEW_SIZE - 1 || y === 0 || y === PREVIEW_SIZE - 1
}

function getFertileTileColor(index: number, fertileSet: Set<number>): string {
  const px = index % PREVIEW_SIZE
  const py = Math.floor(index / PREVIEW_SIZE)
  const adjacentCount = [
    fertileSet.has(index - 1),
    fertileSet.has(index + 1),
    fertileSet.has(index - PREVIEW_SIZE),
    fertileSet.has(index + PREVIEW_SIZE),
    fertileSet.has(index - PREVIEW_SIZE - 1),
    fertileSet.has(index - PREVIEW_SIZE + 1),
    fertileSet.has(index + PREVIEW_SIZE - 1),
    fertileSet.has(index + PREVIEW_SIZE + 1),
  ].filter(Boolean).length
  const noise = ((px * 7 + py * 13) % 5)
  const lightness = adjacentCount >= 6 ? 78 + noise : adjacentCount >= 3 ? 82 + noise : 86 + noise
  const saturation = adjacentCount >= 6 ? 60 : adjacentCount >= 3 ? 50 : 40
  const hue = 42 + (noise - 2)
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

export const SnekConfiguration: React.FC<SnekConfigurationProps> = ({
  maxTurns,
  maxTurnsEnabled,
  onMaxTurnsToggle,
  onMaxTurnsChange,
  hazardPercentage,
  onHazardPercentageChange,
  fertileGroundEnabled,
  onFertileGroundToggle,
  fertileGroundDensity,
  onFertileGroundDensityChange,
  fertileGroundClustering,
  onFertileGroundClusteringChange,
  foodSpawnRate,
  onFoodSpawnRateChange,
}) => {
  const [previewSeed, setPreviewSeed] = React.useState(() => Math.random())

  React.useEffect(() => {
    setPreviewSeed(Math.random())
  }, [fertileGroundDensity, fertileGroundClustering])

  const fertileTiles = useMemo(() => {
    if (!fertileGroundEnabled) return new Set<number>()
    return generatePreviewTiles(fertileGroundDensity, fertileGroundClustering, previewSeed)
  }, [fertileGroundEnabled, fertileGroundDensity, fertileGroundClustering, previewSeed])

  const clusteringLabel = fertileGroundClustering <= 6 ? "Scattered" : fertileGroundClustering <= 14 ? "Clustered" : "Blobby"

  return (
    <FormControl fullWidth margin="normal">
      <div style={{ display: "flex", gap: "15px" }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={maxTurnsEnabled}
              onChange={(e) => onMaxTurnsToggle(e.target.checked)}
            />
          }
          label="Enable Turn Limit"
        />
        <TextField
          type="number"
          label="Max Turns"
          value={maxTurns}
          onChange={(e) => onMaxTurnsChange(parseInt(e.target.value) || 0)}
          sx={{ flex: 1 }}
          inputProps={{ min: 1 }}
          disabled={!maxTurnsEnabled}
        />
        <TextField
          type="number"
          label="Hazard Percentage"
          value={hazardPercentage}
          onChange={(e) => onHazardPercentageChange(parseInt(e.target.value) || 0)}
          sx={{ flex: 1 }}
          inputProps={{ min: 0, max: 100 }}
        />
      </div>
      <Box sx={{ mt: 2 }}>
        <Typography variant="body2" gutterBottom>
          Food Spawn Rate: {foodSpawnRate}/turn
        </Typography>
        <Slider
          value={foodSpawnRate}
          onChange={(_e, value) => onFoodSpawnRateChange(value as number)}
          min={0}
          max={5}
          step={0.25}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => `${v}/turn`}
          sx={{ mx: 1 }}
        />
      </Box>
      <Box sx={{ mt: 1 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={fertileGroundEnabled}
              onChange={(e) => onFertileGroundToggle(e.target.checked)}
            />
          }
          label="Fertile Ground"
        />
        {fertileGroundEnabled && (
          <Box sx={{ ml: 4, mr: 1, mt: 1 }}>
            <Typography variant="body2" gutterBottom>
              Fertile Density: {fertileGroundDensity}%
            </Typography>
            <Slider
              value={fertileGroundDensity}
              onChange={(_e, value) => onFertileGroundDensityChange(value as number)}
              min={5}
              max={80}
              step={5}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v}%`}
            />
            <Typography variant="body2" gutterBottom sx={{ mt: 1 }}>
              Clustering: {fertileGroundClustering} — {clusteringLabel}
            </Typography>
            <Slider
              value={fertileGroundClustering}
              onChange={(_e, value) => onFertileGroundClusteringChange(value as number)}
              min={1}
              max={20}
              step={1}
              marks
              valueLabelDisplay="auto"
            />
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Preview ({PREVIEW_SIZE}×{PREVIEW_SIZE})
                </Typography>
              </Box>
              <Box sx={{ position: "relative", width: "fit-content" }}>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${PREVIEW_SIZE}, 1fr)`,
                    gap: "1px",
                    width: "fit-content",
                    border: "1px solid #555",
                    backgroundColor: "#555",
                  }}
                >
                  {Array.from({ length: PREVIEW_SIZE * PREVIEW_SIZE }, (_, i) => {
                    const isBorder = isBorderTile(i)
                    const isFertile = fertileTiles.has(i)
                    const bg = isBorder
                      ? "#1a1a1a"
                      : isFertile
                        ? getFertileTileColor(i, fertileTiles)
                        : "#2a2a2a"
                    return (
                      <Box
                        key={i}
                        sx={{
                          width: 16,
                          height: 16,
                          backgroundColor: bg,
                        }}
                      />
                    )
                  })}
                </Box>
                <IconButton
                  size="small"
                  onClick={() => setPreviewSeed(Math.random())}
                  sx={{
                    position: "absolute",
                    bottom: 2,
                    right: 2,
                    backgroundColor: "rgba(0,0,0,0.5)",
                    color: "#aaa",
                    padding: "3px",
                    "&:hover": {
                      backgroundColor: "rgba(0,0,0,0.7)",
                      color: "#fff",
                    },
                  }}
                >
                  <RefreshCw size={14} />
                </IconButton>
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </FormControl>
  )
}
