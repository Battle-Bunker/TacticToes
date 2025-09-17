import React, { useState } from "react";
import {
  Button,
  TextField,

  FormControl,

} from "@mui/material";

interface Team {
  id: string;
  name: string;
  color: string;

}

interface TeamConfigurationProps {
  teams: Team[];
  onTeamsChange: (teams: Team[]) => void;
  maxTurns: number;
  onMaxTurnsChange: (turns: number) => void;
}

export const TeamConfiguration: React.FC<TeamConfigurationProps> = ({
  teams,
  onTeamsChange,
  maxTurns,onMaxTurnsChange,
}) => {
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamColor, setNewTeamColor] = useState("#000000");

  const addTeam = () => {
    if (newTeamName.trim()) {
      const newTeam: Team = {
        id: `team_${Date.now()}`,
        name: newTeamName,
        color: newTeamColor,

      };
      onTeamsChange([...teams, newTeam]);
      setNewTeamName("");
    }
  };

  const removeTeam = (teamId: string) => {
    onTeamsChange(teams.filter((team) => team.id !== teamId));
  };

  return (
    <div>
      <h3>Team Configuration</h3>

      {/* Turn Limit */}
      <FormControl fullWidth margin="normal">
        <TextField
          type="number"
          label="Max Turns"
          value={maxTurns}
          onChange={(e) => onMaxTurnsChange(parseInt(e.target.value))}
        />
      </FormControl>

      {/* Team Creation */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <TextField
          label="Team Name"
          value={newTeamName}
          onChange={(e) => setNewTeamName(e.target.value)}
        />
        <input
          type="color"
          value={newTeamColor}
          onChange={(e) => setNewTeamColor(e.target.value)}
          style={{ width: "50px", height: "40px" }}
        />
        <Button 
          variant="contained" 
          onClick={addTeam}
          sx={{ 
            backgroundColor: '#1976d2',
            '&:hover': {
              backgroundColor: '#1565c0'
            }
          }}
        >
          Add Team
        </Button>
      </div>

      {/* Team List */}
      <div>
        {teams.map((team) => (
          <div
            key={team.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px",
              border: "1px solid #ccc",
              marginBottom: "10px",
            }}
          >
            <div
              style={{
                width: "20px",
                height: "20px",
                backgroundColor: team.color,
                borderRadius: "50%",
              }}
            />
            <span>{team.name}</span>
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={() => removeTeam(team.id)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};