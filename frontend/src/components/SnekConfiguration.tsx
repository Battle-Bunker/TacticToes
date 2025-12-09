import React from "react"
import { FormControl, TextField } from "@mui/material"

interface SnekConfigurationProps {
  maxTurns: number
  onMaxTurnsChange: (turns: number) => void
  hazardPercentage: number
  onHazardPercentageChange: (percentage: number) => void
}

export const SnekConfiguration: React.FC<SnekConfigurationProps> = ({
  maxTurns,
  onMaxTurnsChange,
  hazardPercentage,
  onHazardPercentageChange,
}) => {
  return (
    <FormControl fullWidth margin="normal">
      <div style={{ display: "flex", gap: "15px" }}>
        <TextField
          type="number"
          label="Max Turns"
          value={maxTurns}
          onChange={(e) => onMaxTurnsChange(parseInt(e.target.value) || 0)}
          sx={{ flex: 1 }}
          inputProps={{ min: 1 }}
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
