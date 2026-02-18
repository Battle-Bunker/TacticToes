import React from "react"
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
  foodSpawnRate: number
  onFoodSpawnRateChange: (rate: number) => void
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
  foodSpawnRate,
  onFoodSpawnRateChange,
}) => {
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
          Food Spawn Rate: {foodSpawnRate}%
        </Typography>
        <Slider
          value={foodSpawnRate}
          onChange={(_e, value) => onFoodSpawnRateChange(value as number)}
          min={0}
          max={100}
          step={5}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => `${v}%`}
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
          </Box>
        )}
      </Box>
    </FormControl>
  )
}
