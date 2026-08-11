import React from "react";
import { Box, Chip, IconButton, Typography } from "@mui/material";
import { Team } from "@shared/types/Game";
import { ColorPicker } from "./ColorPicker";

interface TeamListProps {
  teams: Team[];
  onColorChange: (teamID: string, color: string) => void;
  onRemove: (teamID: string) => void;
  disabled: boolean;
  // Live presence per centaur id: true while the centaur's ack doc has
  // ready == true. Purely informational — start is never gated on presence.
  centaurStatuses: { [centaurId: string]: boolean };
  // Flips every existing ack back to ready == false so live centaurs must
  // re-ack; unavailable centaurs stay grey.
  onRecheck: () => void;
  recheckDisabled: boolean;
}

export const TeamList: React.FC<TeamListProps> = ({
  teams,
  onColorChange,
  onRemove,
  disabled,
  centaurStatuses,
  onRecheck,
  recheckDisabled,
}) => {
  if (teams.length === 0) {
    return (
      <Typography sx={{ px: 1, py: 1, color: "#999", fontSize: "0.9rem" }}>
        No teams yet — add a centaur below.
      </Typography>
    );
  }

  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "flex-end", px: 1, py: 0.5 }}>
        <Chip
          size="small"
          label="🔄 recheck health"
          onClick={recheckDisabled ? undefined : onRecheck}
          disabled={recheckDisabled}
          variant="outlined"
        />
      </Box>
      {teams.map((team) => (
        <Box
          key={team.id}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1,
            py: 0.5,
            borderLeft: `4px solid ${team.color}`,
            borderBottom: "1px solid #eee",
          }}
        >
          <Box sx={disabled ? { pointerEvents: "none", opacity: 0.6 } : {}}>
            <ColorPicker
              selectedColor={team.color}
              onColorChange={(color) => onColorChange(team.id, color)}
              label=""
            />
          </Box>
          <Typography
            sx={{ fontWeight: 500, flexGrow: 1, wordBreak: "break-word" }}
          >
            {team.name}
          </Typography>
          <Chip
            size="small"
            label={centaurStatuses[team.id] ? "responsive" : "no response"}
            sx={
              centaurStatuses[team.id]
                ? { backgroundColor: "#2e7d32", color: "#fff" }
                : { backgroundColor: "#e0e0e0", color: "#666" }
            }
          />
          <IconButton
            size="small"
            aria-label={`Remove ${team.name}`}
            disabled={disabled}
            onClick={() => onRemove(team.id)}
            sx={{
              border: "1px solid #999",
              borderRadius: "4px",
              width: 28,
              height: 28,
            }}
          >
            ✕
          </IconButton>
        </Box>
      ))}
    </Box>
  );
};
