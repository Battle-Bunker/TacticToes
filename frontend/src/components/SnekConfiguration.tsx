import React from "react"
import { Checkbox, FormControl, FormControlLabel, TextField } from "@mui/material"

interface SnekConfigurationProps {
  maxTurns: number
  maxTurnsEnabled: boolean
  onMaxTurnsToggle: (enabled: boolean) => void
  onMaxTurnsChange: (turns: number) => void
  hazardPercentage: number
  onHazardPercentageChange: (percentage: number) => void
}

export const SnekConfiguration: React.FC<SnekConfigurationProps> = ({
  maxTurns,
  maxTurnsEnabled,
  onMaxTurnsToggle,
  onMaxTurnsChange,
  hazardPercentage,
  onHazardPercentageChange,
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
    </FormControl>
  )
}
