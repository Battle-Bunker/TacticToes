import React, { useMemo } from "react"
import { Checkbox, FormControl, FormControlLabel, Slider, TextField, Typography, Box } from "@mui/material"

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
  const t = (clustering - 1) / 9
  return 2.0 * Math.pow(0.025 / 2.0, t)
}

function generatePreviewTiles(density: number, clustering: number, seed: number): Set<number> {
  const boardSize = 10
  const baseFrequency = clusteringToFrequency(clustering)
  const seedX = seed * 1000
  const seedY = (seed * 577.215 + 0.331) * 1000 % 1000

  const noiseValues: { pos: number; value: number }[] = []
  for (let y = 1; y < boardSize - 1; y++) {
    for (let x = 1; x < boardSize - 1; x++) {
      const pos = y * boardSize + x
      const value = fractalNoise(x + seedX, y + seedY, 4, baseFrequency)
      noiseValues.push({ pos, value })
    }
  }

  noiseValues.sort((a, b) => b.value - a.value)
  const targetCount = Math.max(1, Math.floor((noiseValues.length * density) / 100))
  return new Set(noiseValues.slice(0, targetCount).map(n => n.pos))
}

function isBorderTile(index: number): boolean {
  const x = index % 10
  const y = Math.floor(index / 10)
  return x === 0 || x === 9 || y === 0 || y === 9
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

  const clusteringLabel = fertileGroundClustering <= 3 ? "Scattered" : fertileGroundClustering <= 7 ? "Clustered" : "Blobby"

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
              max={10}
              step={1}
              marks
              valueLabelDisplay="auto"
            />
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" gutterBottom sx={{ color: "text.secondary" }}>
                Preview (10×10)
              </Typography>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(10, 1fr)",
                  gap: "1px",
                  width: "fit-content",
                  border: "1px solid #555",
                  backgroundColor: "#555",
                }}
              >
                {Array.from({ length: 100 }, (_, i) => (
                  <Box
                    key={i}
                    sx={{
                      width: 20,
                      height: 20,
                      backgroundColor: isBorderTile(i) ? "#1a1a1a" : fertileTiles.has(i) ? "#4caf50" : "#2a2a2a",
                    }}
                  />
                ))}
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </FormControl>
  )
}
