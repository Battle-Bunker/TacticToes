import React, { useState } from "react";
import {
  Button,
  TextField,
  FormControl,
} from "@mui/material";
import { ColorPicker } from "./ColorPicker";

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
  maxTurns,
  onMaxTurnsChange,
}) => {
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamColor, setNewTeamColor] = useState("#FF6B6B");

  // Initialize default teams if none exist
  React.useEffect(() => {
    if (teams.length === 0) {
      const defaultTeams: Team[] = [
        { id: 'team_red', name: 'Red Team', color: '#FF6B6B' },
        { id: 'team_blue', name: 'Blue Team', color: '#4ECDC4' }
      ];
      onTeamsChange(defaultTeams);
    }
  }, [teams.length, onTeamsChange]);

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
      <div style={{ display: "flex", gap: "15px", marginBottom: "20px", alignItems: "flex-start" }}>
        <TextField
          label="Team Name"
          value={newTeamName}
          onChange={(e) => setNewTeamName(e.target.value)}
          sx={{ flex: 1 }}
        />
        <ColorPicker
          selectedColor={newTeamColor}
          onColorChange={setNewTeamColor}
          label="Team Color"
        />
        <Button 
          variant="contained" 
          onClick={addTeam}
          sx={{ 
            backgroundColor: '#1976d2',
            '&:hover': {
              backgroundColor: '#1565c0'
            },
            height: '56px',
            px: 3
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
                width: "32px",
                height: "32px",
                backgroundColor: team.color,
                borderRadius: "50%",
                border: "2px solid #fff",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  width: "100%",
                  height: "100%",
                  borderRadius: "50%",
                  border: "1px solid rgba(0,0,0,0.1)",
                }}
              />
            </div>
            <span style={{ fontWeight: 500, fontSize: "16px" }}>{team.name}</span>
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